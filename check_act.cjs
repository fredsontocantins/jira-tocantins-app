const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
  await page.fill('#loginUser', 'operacoes');
  await page.fill('#loginPass', 'operacoes@123');
  await page.click('#loginBtn');
  await page.waitForTimeout(6000);
  const info = await page.evaluate(() => ({ activityLen: (window.activityData||[]).length, dataLen: (window.data||[]).length }));
  console.log(JSON.stringify(info));
  await browser.close();
})();
EOF