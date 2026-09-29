const { test, expect } = require('@playwright/test');

test('collapsed Review syncs remote comments and shows save progress', async ({ page }) => {
  const comments = [];
  let releasePost;
  const postGate = new Promise(resolve => { releasePost = resolve; });
  await page.route('**/v1/comments**', async route => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { comments } });
    }
    const draft = route.request().postDataJSON();
    await postGate;
    const saved = { ...draft, replies: [], resolved: false, createdAt: new Date().toISOString() };
    comments.push(saved);
    return route.fulfill({ status: 201, json: saved });
  });
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('an-author', 'Reviewer');
    window.AnnotateConfig = { key: 'test', apiBase: location.origin };
  });
  await page.addScriptTag({ url: '/annotate.js' });
  await expect(page.locator('#__an_launch')).toBeVisible();

  comments.push({ id: 'remote-comment', page: '/', type: 'note', author: 'MM', text: 'Remote review', color: '#f59e0b', replies: [], resolved: false });
  await expect(page.locator('#__an_launch')).toContainText('Review (1)', { timeout: 8000 });

  await page.locator('#__an_launch').click();
  await page.locator('[data-tool="pin"]').click();
  await page.mouse.click(300, 300);
  await page.locator('#__an_compose textarea').fill('My review');
  await page.locator('#__an_compose .an-primary').click();
  await expect(page.locator('#__an_compose .an-primary')).toHaveText('Submitting…');
  await expect(page.locator('#__an_compose .an-ghost')).toBeDisabled();
  releasePost();
  await expect(page.locator('#__an_compose')).not.toHaveClass(/an-show/);
  await expect.poll(() => page.evaluate(() => window.Annotate.comments().length)).toBe(2);
});

test('a slow previous-tab response cannot replace the active tab comments', async ({ page }) => {
  let mainStarted;
  let releaseMain;
  const started = new Promise(resolve => { mainStarted = resolve; });
  const gate = new Promise(resolve => { releaseMain = resolve; });
  await page.route('**/v1/comments**', async route => {
    const key = new URL(route.request().url()).searchParams.get('page');
    if (key === '/#main') {
      mainStarted();
      await gate;
    }
    const comment = { id: key === '/#main' ? 'main' : 'documents', page: key, type: 'note', author: 'MM', text: key, color: '#f59e0b', replies: [], resolved: false };
    return route.fulfill({ json: { comments: [comment] } });
  });
  await page.goto('/#main');
  await page.evaluate(() => { window.AnnotateConfig = { key: 'test', apiBase: location.origin }; });
  await page.addScriptTag({ url: '/annotate.js' });
  await started;
  await page.evaluate(() => { location.hash = '#documents'; });
  await expect.poll(() => page.evaluate(() => window.Annotate.comments().map(c => c.id))).toEqual(['documents']);
  releaseMain();
  await expect.poll(() => page.evaluate(() => window.Annotate.comments().map(c => c.id))).toEqual(['documents']);
});
