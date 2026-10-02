const fs = require('fs');

class ScheduleDownloader {
    constructor({
        sessionId,
        id,
        dateFrom,
        dateTo,
        outputPath = './tmp/harmonogram.csv',
        origUrl,
    } = {}) {
        this.sessionId = sessionId;
        this.id = id;
        this.dateFrom = dateFrom;
        this.dateTo = dateTo;
        this.outputPath = outputPath;
        this.origUrl = origUrl;
        this.retryLimit = 5;
        this.retryCount = 0;
    }

    async downloadSchedule() {
        const params = new URLSearchParams({
            dO: this.dateFrom,
            dD: this.dateTo,
        });

        const url =
            `${this.origUrl}${this.id}?${params.toString()}`;

        console.log('Downloading:');
        console.log(url);

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Cookie': `ASP.NET_SessionId=${this.sessionId}; .culture=c=pl|uic=pl`,
                'Referer': `${this.origUrl}${this.id}`,
                'User-Agent': 'Mozilla/5.0',
                'Accept': '*/*',
            },
        });

        console.log(`HTTP status: ${response.status}`);

        if (!response.ok) {
            const body = await response.text();

            if (response.status === 429) {
                console.warn('Received 429 Too Many Requests. Retrying after 60 seconds...');
                this.retryCount += 1;
                if (this.retryCount >= this.retryLimit) {
                    throw new Error(`Exceeded retry limit of ${this.retryLimit}.`);
                }
                await new Promise(resolve => setTimeout(resolve, 60000));
                return this.downloadSchedule();
            }

            throw new Error(`Request failed (HTTP ${response.status}): ${body}`);
        }

        const buffer = Buffer.from(await response.arrayBuffer());

        fs.writeFileSync(this.outputPath, buffer);

        console.log(`Saved ${this.outputPath} (${buffer.length} bytes)`);
        this.retryCount = 0; // Reset retry count on successful download
        return this.outputPath;
    }

    checkFileSize() {
        if (!fs.existsSync(this.outputPath)) {
            throw new Error(`File not found: ${this.outputPath}`);
        }
        const stats = fs.statSync(this.outputPath);
        if (stats.size === 0) {
            throw new Error(`File is empty: ${this.outputPath}`);
        }
    }

}

module.exports = ScheduleDownloader;

if (require.main === module) {
    const downloader = new ScheduleDownloader();
    downloader.downloadSchedule().catch((error) => {
        console.error(error);
        downloader.checkFileSize();
    });
}
