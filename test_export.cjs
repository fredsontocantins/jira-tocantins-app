const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.on('console', m => console.log('CONSOLE:', m.text()));
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
  await page.fill('#loginUser', 'operacoes');
  await page.fill('#loginPass', 'operacoes@123');
  await page.click('#loginBtn');
  await page.waitForTimeout(8000);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.click('#exportPdf')
  ]);
  const path = '/home/casa/jira-tocantins-app/test_export.pdf';
  await download.saveAs(path);
  console.log('SAVED', path);
  await browser.close();
})();