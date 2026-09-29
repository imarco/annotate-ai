const { test, expect } = require('@playwright/test');

test('SVG node annotation follows a transformed graph cell', async ({ page }) => {
  const comments = [];
  await page.route('**/v1/comments**', async route => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { comments } });
    }
    const draft = route.request().postDataJSON();
    const comment = { ...draft, id: 'svg-cell-comment', replies: [], resolved: false };
    comments.push(comment);
    return route.fulfill({ json: comment });
  });
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('an-author', 'Graph tester');
    window.AnnotateConfig = { key: 'test', apiBase: location.origin };
    const root = document.createElement('div');
    root.id = 'diagram';
    root.innerHTML = '<svg width="400" height="300"><g data-cell-id="node-1" data-shape="node"><rect x="40" y="40" width="160" height="120" fill="#dbeafe"/></g></svg>';
    document.body.appendChild(root);
  });
  await page.addScriptTag({ url: '/annotate.js' });
  await expect(page.locator('#__an_launch')).toBeVisible();
  await page.locator('#__an_launch').click();
  await page.keyboard.press('r');
  const node = page.locator('[data-cell-id="node-1"] rect');
  const box = await node.boundingBox();
  // Start in canvas whitespace, as people do when framing a whole node.
  await page.mouse.move(box.x - 15, box.y - 15);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 80);
  await page.mouse.up();
  await page.locator('#__an_compose textarea').fill('Node position');
  await page.locator('#__an_compose .an-primary').click();

  const selector = await page.evaluate(() => window.Annotate.comments()[0].geom.selector);
  expect(selector).toBe('#diagram [data-cell-id=node-1]');
  const mark = page.locator('#__an_overlay rect.an-hit');
  const before = await mark.boundingBox();
  await page.locator('[data-cell-id="node-1"]').evaluate(el => el.setAttribute('transform', 'translate(100 0)'));
  await expect.poll(async () => (await mark.boundingBox()).x).toBeCloseTo(before.x + 100, 0);
});
