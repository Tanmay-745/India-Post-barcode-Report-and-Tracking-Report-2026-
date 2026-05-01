const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function testPdf() {
    console.log('Testing PDF generation in headful mode via CDP...');
    const browserContext = await chromium.launchPersistentContext(path.join(__dirname, 'chrome_profile_test'), { 
        headless: false,
        channel: 'chrome', 
        acceptDownloads: true 
    });
    const page = browserContext.pages()[0] || await browserContext.newPage();
    await page.goto('https://example.com');
    
    try {
        const client = await page.context().newCDPSession(page);
        console.log('Sending Page.printToPDF...');
        const { data } = await client.send('Page.printToPDF', {
            printBackground: true,
            marginTop: 0.4,
            marginBottom: 0.4,
            marginLeft: 0.4,
            marginRight: 0.4
        });
        console.log('Data length:', data.length);
        fs.writeFileSync('test.pdf', Buffer.from(data, 'base64'));
        console.log('Success!');
    } catch (e) {
        console.error('Failed CDP PrintToPDF:', e);
    }
    await browserContext.close();
}

testPdf().catch(console.error);
