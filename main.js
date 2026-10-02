const fs = require('fs');
const path = require('path');
const ScheduleDownloader = require('./download');
const CSVParser = require('./parser');
const FilterSchedule = require('./filter');
const GoogleCalendar = require('./calendar');

const INTERVAL_MS = 15 * 60 * 1000;

function scheduleDate(value) {
    // The download endpoint uses MM/DD/YYYY, independent of the host locale.
    const match = typeof value === 'string'
        && value.match(/^(\d{2})\/(\d{2})\/(\d{4}) 00:00:00$/);
    if (!match) throw new Error('Schedule dates must use MM/DD/YYYY 00:00:00.');
    const date = `${match[3]}-${match[1]}-${match[2]}`;
    const timestamp = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) {
        throw new Error(`Invalid schedule date: ${value}`);
    }
    return date;
}

class ScheduleUpdater {
    constructor(options) {
        this.groupFilters = options.groupFilters ?? [];
        if (!Array.isArray(this.groupFilters)
            || this.groupFilters.some(filter => typeof filter !== 'string' || !filter.trim())) {
            throw new Error('groupFilters must be an array of nonempty strings.');
        }
        const dateFrom = scheduleDate(options.dateFrom);
        const dateTo = scheduleDate(options.dateTo);
        // Include the whole final schedule day; Google timeMax is exclusive.
        const timeMax = new Date(Date.parse(`${dateTo}T00:00:00Z`) + 24 * 60 * 60 * 1000)
            .toISOString().slice(0, 10);
        this.outputPath = path.resolve(__dirname, options.outputPath || './tmp/harmonogram.csv');
        this.downloader = new ScheduleDownloader({
            sessionId: options.sessionId,
            id: options.scheduleID,
            dateFrom: options.dateFrom,
            dateTo: options.dateTo,
            origUrl: options.url,
            outputPath: this.outputPath,
        });
        this.calendar = new GoogleCalendar({
            calendarId: options.calendarId,
            timeZone: options.timeZone,
            sourceId: options.sourceId,
            credentialsPath: options.credentialsPath
                ? path.resolve(__dirname, options.credentialsPath) : undefined,
            tokenPath: options.tokenPath
                ? path.resolve(__dirname, options.tokenPath) : undefined,
            planName: options.planName,
            timeMin: dateFrom,
            timeMax,
        });
        this.initialized = false;
        this.running = false;
        this.timer = null;
    }

    async runOnce() {
        if (this.running) {
            console.log('Previous schedule update is still running; skipping this interval.');
            return null;
        }
        this.running = true;
        try {
            console.log(`[${new Date().toISOString()}] Starting schedule update.`);
            fs.mkdirSync(path.dirname(this.outputPath), { recursive: true });
            // A new cycle gets a fresh retry budget after a failed download.
            this.downloader.retryCount = 0;
            const filename = await this.downloader.downloadSchedule();
            this.downloader.checkFileSize();

            const parser = new CSVParser(filename);
            const events = parser.parse();
            parser.checkJsonisEmpty();
            const filtered = new FilterSchedule(events, this.groupFilters).filterByGroup();

            if (!this.initialized) {
                await this.calendar.init();
                this.initialized = true;
            }
            // syncEvents handles matching, creates, updates and removed events.
            const plan = await this.calendar.syncEvents(filtered);
            console.log(`Schedule update complete: ${events.length} parsed, ${filtered.length} filtered; `
                + `${plan.create.length} created, ${plan.update.length} updated, `
                + `${plan.delete.length} deleted, ${plan.unchanged.length} unchanged, ${plan.ignored} ignored.`);
            return plan;
        } finally {
            this.running = false;
        }
    }

    start() {
        if (this.timer !== null) return this;
        const execute = () => {
            this.runOnce().catch(error => {
                console.error('Schedule update failed; will retry at the next 15-minute interval:', error);
            });
        };
        this.timer = setInterval(execute, INTERVAL_MS);
        execute();
        return this;
    }

    stop() {
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
    }
}

module.exports = { ScheduleUpdater, INTERVAL_MS };

if (require.main === module) {
    try {
        // Resolve configuration relative to the app even when launched elsewhere.
        process.env.NODE_CONFIG_DIR ||= path.join(__dirname, 'config');
        const config = require('config');
        const updater = new ScheduleUpdater(config.util.toObject()).start();
        const shutdown = () => {
            updater.stop();
            console.log('Schedule updater stopped. Any active update will finish.');
        };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
    } catch (error) {
        console.error('Could not start schedule updater:', error);
        process.exitCode = 1;
    }
}
