import fs from 'fs/promises';
import path from 'path';
import puppeteer from 'puppeteer-core';

const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
const headless = process.env.PUPPETEER_HEADLESS !== 'false';
const targetUrl = process.env.TARGET_URL || 'http://127.0.0.1:8083/';
const outputDir = process.env.OUTPUT_DIR || '/app/out';

const viewports = [
  { name: 'desktop', width: 1365, height: 900 },
  { name: 'wide', width: 1800, height: 1000 },
  { name: 'mobile', width: 390, height: 900 },
];

await fs.mkdir(outputDir, { recursive: true });

function intersects(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

const browser = await puppeteer.launch({
  executablePath,
  headless: headless ? 'new' : false,
  args: [
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--window-size=1365,900',
  ],
});

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);

  for (const viewport of viewports) {
    await page.setViewport({
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
    });

    await page.goto(targetUrl, { waitUntil: 'networkidle2' });
    await page.waitForSelector('#timeline');
    await page.waitForSelector('[data-weather-card="forecast"]');
    await page.waitForSelector('[data-weather-card="actual"]', { timeout: 3000 }).catch(() => {});
    await page.waitForSelector('[data-demand-block]', { timeout: 3000 }).catch(() => {});

    const report = await page.evaluate(() => {
      const rectOf = (el) => {
        const rect = el.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        };
      };

      const scroll = document.querySelector('.timeline-scroll');
      const timeline = document.querySelector('#timeline');
      const timelineRect = timeline.getBoundingClientRect();
      const contentLeft = timelineRect.left + 174;
      const effectiveEndRight = contentLeft + Number(timeline.dataset.timelineEndX || timelineRect.width - 174);
      const forecastCards = [...document.querySelectorAll('[data-weather-card="forecast"]')].map(rectOf);
      const actualCards = [...document.querySelectorAll('[data-weather-card="actual"]')].map(rectOf);
      const preciseBlocks = [...document.querySelectorAll('[data-precise-block]')].map(rectOf);
      const demandBlocks = [...document.querySelectorAll('[data-demand-block]')].map((el) => {
        const styles = getComputedStyle(el);
        return {
          ...rectOf(el),
          borderRadius: styles.borderRadius,
        };
      });

      const sortedDemand = [...demandBlocks].sort((a, b) => a.left - b.left);
      const demandGaps = sortedDemand.slice(0, -1).map((block, index) => {
        const next = sortedDemand[index + 1];
        return Math.max(0, next.left - block.right);
      });

      return {
        url: location.href,
        title: document.querySelector('#dateTitle')?.textContent || '',
        timeline: {
          clientWidth: scroll.clientWidth,
          scrollWidth: scroll.scrollWidth,
          timelineWidth: timeline.getBoundingClientRect().width,
          effectiveEndRight,
          hasHorizontalScroll: scroll.scrollWidth > scroll.clientWidth,
        },
        counts: {
          forecastCards: forecastCards.length,
          actualCards: actualCards.length,
          demandBlocks: demandBlocks.length,
          preciseBlocks: preciseBlocks.length,
        },
        forecastCards,
        actualCards,
        preciseBlocks,
        demandBlocks,
        demandGaps,
      };
    });

    const weatherOverlaps = [];
    for (const forecast of report.forecastCards) {
      for (const actual of report.actualCards) {
        if (intersects(forecast, actual)) weatherOverlaps.push({ forecast, actual });
      }
    }

    const roundedDemand = report.demandBlocks.filter((block) => block.borderRadius !== '0px');
    const largeDemandGaps = report.demandGaps.filter((gap) => gap > 0.75);
    const overflowingLastSegments = [
      Math.max(...report.demandBlocks.map((block) => block.right)),
      Math.max(...report.preciseBlocks.map((block) => block.right)),
    ].filter((right) => right > report.timeline.effectiveEndRight + 1);

    const assertions = {
      hasHorizontalScroll: report.timeline.hasHorizontalScroll,
      hasForecastCards: report.counts.forecastCards > 0,
      hasActualCards: report.counts.actualCards > 0,
      hasDemandBlocks: report.counts.demandBlocks > 0,
      hasPreciseBlocks: report.counts.preciseBlocks > 0,
      weatherOverlapCount: weatherOverlaps.length,
      roundedDemandCount: roundedDemand.length,
      demandGapCount: largeDemandGaps.length,
      finalSegmentOverflowCount: overflowingLastSegments.length,
    };

    await fs.writeFile(
      path.join(outputDir, `${viewport.name}-report.json`),
      JSON.stringify({ ...report, assertions, weatherOverlaps, largeDemandGaps, overflowingLastSegments }, null, 2),
    );

    await page.screenshot({
      path: path.join(outputDir, `${viewport.name}.png`),
      fullPage: true,
    });

    await page.evaluate(() => {
      const el = document.querySelector('.timeline-scroll');
      el.scrollLeft = el.scrollWidth;
    });

    await page.screenshot({
      path: path.join(outputDir, `${viewport.name}-scrolled-end.png`),
      fullPage: true,
    });

    const optionalKeys = new Set(['hasActualCards', 'hasDemandBlocks', 'hasPreciseBlocks']);
    const failures = Object.entries(assertions)
      .filter(([key, value]) => optionalKeys.has(key) ? false : (key.endsWith('Count') ? value !== 0 : !value))
      .map(([key, value]) => `${key}=${value}`);

    if (failures.length) {
      throw new Error(`${viewport.name} visual assertions failed: ${failures.join(', ')}`);
    }
  }
} finally {
  await browser.close();
}
