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

    getTerminCookie() {
        if (!this.dateFrom || !this.dateTo) return '';
        const matchFrom = typeof this.dateFrom === 'string' && this.dateFrom.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
        const matchTo = typeof this.dateTo === 'string' && this.dateTo.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
        if (matchFrom && matchTo) {
            const m1 = parseInt(matchFrom[1], 10);
            const d1 = parseInt(matchFrom[2], 10);
            const y1 = parseInt(matchFrom[3], 10);
            const m2 = parseInt(matchTo[1], 10);
            const d2 = parseInt(matchTo[2], 10);
            const y2 = parseInt(matchTo[3], 10);
            return `RadioList_TerminT=${y1},${m1},${d1}%5C${y2},${m2},${d2}%5C3`;
        }
        return '';
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

        const cookieParts = [
            `ASP.NET_SessionId=${this.sessionId}`,
            '.culture=c=pl|uic=pl',
        ];
        const termin = this.getTerminCookie();
        if (termin) cookieParts.push(termin);

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Cookie': cookieParts.join('; '),
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
