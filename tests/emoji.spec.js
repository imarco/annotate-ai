const { test, expect } = require('@playwright/test');

test('reply emoji picker stays visible outside the scrolling comments list', async ({ page }) => {
  await page.route('**/embed.js', route => route.fulfill({ path: 'dist/embed.js', contentType: 'application/javascript' }));
  await page.route('**/embed.css', route => route.fulfill({ path: 'dist/embed.css', contentType: 'text/css' }));
  await page.route('**/emoji-data.json', route => route.fulfill({ path: 'dist/emoji-data.json', contentType: 'application/json' }));
  await page.route('**/v1/comments**', route => route.fulfill({ json: { comments: [
    { id: 'existing', page: '/', type: 'note', author: 'MM', text: 'Review', color: '#f59e0b', replies: [], resolved: false },
  ] } }));
  await page.goto('/?key=test');
  await page.evaluate(() => localStorage.setItem('an-author', 'Reviewer'));
  await page.reload();
  await page.locator('#__an_launch').click();
  await page.locator('.an-cact button').first().evaluate(button => button.click());
  await page.getByRole('button', { name: 'Choose emoji' }).evaluate(button => button.click());

  await expect(page.locator('.an-emoji-pop')).toBeVisible();
  const placement = await page.locator('.an-emoji-pop').evaluate(pop => {
    const box = pop.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      parent: pop.parentElement.tagName,
      top: box.top,
      bottom: box.bottom,
      hittable: pop.contains(hit),
      viewportHeight: innerHeight,
    };
  });
  expect(placement.parent).toBe('BODY');
  expect(placement.top).toBeGreaterThanOrEqual(0);
  expect(placement.bottom).toBeLessThanOrEqual(placement.viewportHeight);
  expect(placement.hittable).toBe(true);

  await page.locator('[data-tool="pin"]').evaluate(button => button.click());
  await page.mouse.click(300, 300);
  await expect(page.locator('#__an_compose')).toHaveClass(/an-show/);
  await page.locator('#__an_compose [aria-label="Choose emoji"]').evaluate(button => button.click());
  await page.locator('.an-emoji-pop').dispatchEvent('pointerdown', { bubbles: true });
  await expect(page.locator('#__an_compose')).toHaveClass(/an-show/);
  await page.locator('.an-emoji-pop emoji-picker').evaluate(picker => {
    picker.dispatchEvent(new CustomEvent('emoji-click', { detail: { unicode: '😀' } }));
  });
  await expect(page.locator('#__an_compose textarea')).toHaveValue('😀');
});
