const fs = require('fs');

class ScheduleDownloader {
    constructor({
        sessionId,
        id,
        dateFrom,
        dateTo,
        outputPath = 'harmonogram.csv',
    } = {}) {
        this.sessionId = sessionId;
        this.id = id;
        this.dateFrom = dateFrom;
        this.dateTo = dateTo;
        this.outputPath = outputPath;
    }

    async downloadSchedule() {
        const params = new URLSearchParams({
            dO: this.dateFrom,
            dD: this.dateTo,
        });

        const url =
            `https://harmonogram.krakow.ideis.pl/Plany/WydrukTokuCsv/${this.id}?${params.toString()}`;

        console.log('Downloading:');
        console.log(url);

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Cookie': `ASP.NET_SessionId=${this.sessionId}; .culture=c=pl|uic=pl`,
                'Referer': `https://harmonogram.krakow.ideis.pl/Plany/PlanyTokow/${this.id}`,
                'User-Agent': 'Mozilla/5.0',
                'Accept': '*/*',
            },
        });

        console.log(`HTTP status: ${response.status}`);

        if (!response.ok) {
            const body = await response.text();

            throw new Error(`Request failed (HTTP ${response.status}): ${body}`);
        }

        const buffer = Buffer.from(await response.arrayBuffer());

        fs.writeFileSync(this.outputPath, buffer);

        console.log(`Saved ${this.outputPath} (${buffer.length} bytes)`);
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
