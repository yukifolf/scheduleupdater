const fs = require('fs');

class ScheduleDownloader {
    constructor({
        sessionId,
        autoSession,
        id,
        dateFrom,
        dateTo,
        outputPath = './tmp/harmonogram.csv',
        origUrl,
        viewUrl,
    } = {}) {
        this.sessionId = sessionId;
        this.autoSession = autoSession ?? !sessionId;
        this.id = id;
        this.dateFrom = dateFrom;
        this.dateTo = dateTo;
        this.outputPath = outputPath;
        this.origUrl = origUrl;
        this.viewUrl = viewUrl;
        this.retryLimit = 5;
        this.retryCount = 0;
    }

    getViewUrl() {
        let base = this.viewUrl;
        if (!base && this.origUrl) {
            if (this.origUrl.includes('/WydrukTokuCsv')) {
                base = this.origUrl.replace(/\/WydrukTokuCsv\/?$/, '/PlanyTokow/');
            } else {
                try {
                    const parsed = new URL(this.origUrl);
                    base = `${parsed.origin}/Plany/PlanyTokow/`;
                } catch {
                    base = this.origUrl;
                }
            }
        }
        if (!base) return '';
        if (this.id && !base.endsWith(`/${this.id}`)) {
            return base.endsWith('/') ? `${base}${this.id}` : `${base}/${this.id}`;
        }
        return base;
    }

    async fetchSessionId() {
        const viewUrl = this.getViewUrl();
        if (!viewUrl) {
            throw new Error('Cannot obtain sessionId automatically: viewUrl or origUrl is missing.');
        }

        console.log(`Obtaining session from: ${viewUrl}`);
        const cookieParts = ['.culture=c=pl|uic=pl'];
        const termin = this.getTerminCookie();
        if (termin) cookieParts.push(termin);

        const response = await fetch(viewUrl, {
            method: 'GET',
            headers: {
                'Cookie': cookieParts.join('; '),
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'text/html,*/*',
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to obtain session from ${viewUrl} (HTTP ${response.status})`);
        }

        let cookies = [];
        if (typeof response.headers?.getSetCookie === 'function') {
            cookies = response.headers.getSetCookie();
        } else if (response.headers?.get) {
            const raw = response.headers.get('set-cookie');
            if (raw) cookies = [raw];
        }

        for (const cookie of cookies) {
            const match = typeof cookie === 'string' && cookie.match(/ASP\.NET_SessionId=([^;]+)/i);
            if (match) {
                return match[1];
            }
        }

        throw new Error(`ASP.NET_SessionId cookie not found in response from ${viewUrl}`);
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
        let activeSessionId = this.sessionId;
        if (!activeSessionId || this.autoSession) {
            activeSessionId = await this.fetchSessionId();
        }

        const params = new URLSearchParams({
            dO: this.dateFrom,
            dD: this.dateTo,
        });

        const url =
            `${this.origUrl}${this.id}?${params.toString()}`;

        console.log('Downloading:');
        console.log(url);

        const cookieParts = [
            `ASP.NET_SessionId=${activeSessionId}`,
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

        // Detect if a manually configured session expired on the server (indicated by header-only response without event data).
        const textPreview = buffer.toString('utf8');
        if (!this.autoSession && textPreview.includes('Plan dla toku:') && !textPreview.includes('Data Zajec:')) {
            console.warn('Configured sessionId returned empty plan (session likely expired). Fetching a fresh session...');
            this.autoSession = true;
            return this.downloadSchedule();
        }

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
