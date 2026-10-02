const { createHash } = require('crypto');
const path = require('path');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const hash = value => createHash('sha256').update(value).digest('hex');

class GoogleCalendar {
    // timeMin is inclusive, timeMax exclusive. Date-only boundaries mean local midnight.
    constructor({
        calendarId = 'primary', timeMin, timeMax,
        timeZone = 'Europe/Warsaw', sourceId = 'scheduleupdater',
        credentialsPath = path.join(__dirname, 'credentials.json'),
        tokenPath = path.join(path.dirname(credentialsPath), 'token.json'),
        planName,
    } = {}) {
        if (typeof sourceId !== 'string' || !sourceId.trim() || sourceId.length > 1024) {
            throw new Error('sourceId must be a nonempty string of at most 1024 characters.');
        }
        this.calendarId = calendarId;
        this.timeZone = timeZone;
        this.sourceId = sourceId;
        this.credentialsPath = credentialsPath;
        this.tokenPath = tokenPath;
        this.planName = planName;
        this.auth = null;
        this.calendar = null;
        this.formatter = new Intl.DateTimeFormat('en-GB', {
            timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
        });
        this.rangeStart = this.toTimestamp(timeMin);
        this.rangeEnd = this.toTimestamp(timeMax);
        if (this.rangeStart >= this.rangeEnd) throw new Error('timeMin must be earlier than timeMax.');
        this.timeMin = new Date(this.rangeStart).toISOString();
        this.timeMax = new Date(this.rangeEnd).toISOString();
    }

    localDateTime(timestamp) {
        const parts = Object.fromEntries(this.formatter.formatToParts(timestamp)
            .map(part => [part.type, part.value]));
        return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
    }

    toTimestamp(value) {
        if (typeof value !== 'string') throw new Error('Dates must be ISO strings.');
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
            const timestamp = Date.parse(value);
            if (!Number.isFinite(timestamp)) throw new Error(`Invalid date: ${value}`);
            return timestamp;
        }
        const local = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value;
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(local)) throw new Error(`Invalid ISO date: ${value}`);
        const wallTime = Date.parse(`${local}Z`);
        if (!Number.isFinite(wallTime) || new Date(wallTime).toISOString().slice(0, 19) !== local) {
            throw new Error(`Invalid date: ${value}`);
        }
        let timestamp = wallTime;
        for (let attempt = 0; attempt < 4; attempt++) {
            const difference = wallTime - Date.parse(`${this.localDateTime(timestamp)}Z`);
            if (difference === 0) return timestamp;
            timestamp += difference;
        }
        throw new Error(`Local time does not exist in ${this.timeZone}: ${value}`);
    }

    async init() {
        const fs = require('fs');
        const { google } = require('googleapis');

        const saveTokens = (tokens) => {
            try {
                let existing = {};
                if (fs.existsSync(this.tokenPath)) {
                    try {
                        existing = JSON.parse(fs.readFileSync(this.tokenPath, 'utf8'));
                    } catch {}
                }
                const merged = { ...existing, ...tokens };
                fs.mkdirSync(path.dirname(this.tokenPath), { recursive: true });
                fs.writeFileSync(this.tokenPath, JSON.stringify(merged, null, 2));
            } catch (err) {
                console.error(`Failed to save token to ${this.tokenPath}:`, err);
            }
        };

        if (fs.existsSync(this.tokenPath)) {
            try {
                const tokenData = JSON.parse(fs.readFileSync(this.tokenPath, 'utf8'));
                if (tokenData && (tokenData.access_token || tokenData.refresh_token)) {
                    const credentials = JSON.parse(fs.readFileSync(this.credentialsPath, 'utf8'));
                    const keys = credentials.installed || credentials.web;
                    if (!keys) {
                        throw new Error('Credentials file must define an "installed" or "web" client.');
                    }
                    const client = new google.auth.OAuth2(
                        keys.client_id,
                        keys.client_secret,
                        keys.redirect_uris?.[0] || 'http://localhost'
                    );
                    client.setCredentials(tokenData);
                    client.on('tokens', (tokens) => saveTokens(tokens));
                    this.auth = client;
                    this.calendar = google.calendar({ version: 'v3', auth: this.auth });
                    return this;
                }
            } catch (error) {
                console.warn(`Could not load saved token from ${this.tokenPath}: ${error.message}. Re-authenticating.`);
            }
        }

        const { authenticate } = require('@google-cloud/local-auth');
        this.auth = await authenticate({ keyfilePath: this.credentialsPath, scopes: SCOPES });
        if (this.auth?.credentials) {
            saveTokens(this.auth.credentials);
        }
        this.auth.on('tokens', (tokens) => saveTokens(tokens));
        this.calendar = google.calendar({ version: 'v3', auth: this.auth });
        return this;
    }

    async listEvents(calendarId = this.calendarId, timeMin = this.timeMin, timeMax = this.timeMax) {
        if (!this.calendar) throw new Error('Call init() before accessing Google Calendar.');
        const events = [];
        let pageToken;
        do {
            const response = await this.calendar.events.list({
                calendarId, timeMin, timeMax, pageToken, singleEvents: true,
                showDeleted: false, orderBy: 'startTime', maxResults: 2500, timeZone: this.timeZone,
            });
            events.push(...(response.data.items || []));
            pageToken = response.data.nextPageToken;
        } while (pageToken);
        return events;
    }

    isManaged(event) {
        return event.extendedProperties?.private?.scheduleSource === this.sourceId;
    }

    getEventKeyForMatching(event) {
        // End time and room are excluded so those edits retain the Google ID.
        return hash(JSON.stringify([event.subject, event.group, this.toTimestamp(event.start)]));
    }

    formatDateWithWeekday(date) {
        if (!date) return '';
        try {
            const dateObj = new Date(`${date}T12:00:00Z`);
            const weekday = dateObj.toLocaleDateString('pl-PL', { weekday: 'long' });
            return `${date.replace(/-/g, '.')} ${weekday}`;
        } catch {
            return date;
        }
    }

    formatDescription(event) {
        const lines = [];
        const plan = event.plan || this.planName;
        if (plan) {
            lines.push(plan.startsWith('Plan dla toku:') ? plan : `Plan dla toku: ${plan}`);
            lines.push('');
        }
        const dateStr = event.rawDate || this.formatDateWithWeekday(event.date);
        lines.push(` Data zajęć: ${dateStr}`);
        lines.push(` Czas od: ${event.timeFrom || ''}`);
        lines.push(` Czas do: ${event.timeTo || ''}`);
        lines.push(` Liczba godzin: ${event.duration || ''}`);
        lines.push(` Przedmiot: ${event.subject || ''}`);
        lines.push(` Forma zajęć: ${event.form || ''}`);
        lines.push(` Grupy: ${event.group || ''}`);
        lines.push(` Sala: ${event.room || ''}`);
        lines.push(` Prowadzący: ${event.teacher || ''}`);
        lines.push(` Forma zaliczenia: ${event.examType || ''}`);
        lines.push(` Uwagi: ${event.notes || ''}`);
        return lines.join('\n');
    }

    toGoogleEvent(event) {
        return {
            summary: event.subject,
            location: event.room || '',
            description: this.formatDescription(event),
            start: { dateTime: new Date(this.toTimestamp(event.start)).toISOString(), timeZone: this.timeZone },
            end: { dateTime: new Date(this.toTimestamp(event.end)).toISOString(), timeZone: this.timeZone },
            extendedProperties: { private: {
                scheduleSource: this.sourceId,
                scheduleKey: this.getEventKeyForMatching(event),
                scheduleGroup: hash(event.group || ''),
            } },
        };
    }

    calendarRecord(event) {
        if (!event.start?.dateTime || !event.end?.dateTime || event.status === 'cancelled') return null;
        const start = this.toTimestamp(event.start.dateTime);
        const end = this.toTimestamp(event.end.dateTime);
        // Google lists overlapping events; manage only events wholly inside the range.
        if (start < this.rangeStart || start >= this.rangeEnd || end > this.rangeEnd) return null;
        let groupHash = event.extendedProperties?.private?.scheduleGroup || null;
        if (!groupHash && event.description) {
            try {
                const data = JSON.parse(event.description);
                if (typeof data?.group === 'string') groupHash = hash(data.group);
            } catch {
                const match = event.description.match(/^\s*Grupy:\s*(.+)$/m);
                if (match) groupHash = hash(match[1].trim());
            }
        }
        const owner = event.extendedProperties?.private?.scheduleSource;
        return {
            event, start, end, date: this.localDateTime(start).slice(0, 10),
            subject: event.summary || '',
            group: groupHash,
            managed: this.isManaged(event),
            adoptable: !owner && !event.recurringEventId,
        };
    }

    needsUpdate(existing, desired) {
        return existing.summary !== desired.summary
            || (existing.location || '') !== desired.location
            || (existing.description || '') !== desired.description
            || this.toTimestamp(existing.start.dateTime) !== this.toTimestamp(desired.start.dateTime)
            || this.toTimestamp(existing.end.dateTime) !== this.toTimestamp(desired.end.dateTime)
            || existing.start.timeZone !== this.timeZone || existing.end.timeZone !== this.timeZone
            || Object.entries(desired.extendedProperties.private).some(([key, value]) =>
                existing.extendedProperties?.private?.[key] !== value);
    }

    async syncEvents(events, { dryRun = false } = {}) {
        if (!Array.isArray(events)) throw new Error('Schedule must be an array of events.');
        // Validate before API writes. An empty array clears this source's events in the range.
        const desired = [];
        const keys = new Set();
        let ignored = 0;
        for (const event of events) {
            if (!event || typeof event.subject !== 'string' || !event.subject.trim()
                || typeof event.group !== 'string') {
                throw new Error('Each schedule event needs a subject and a group string.');
            }
            const start = this.toTimestamp(event.start);
            const end = this.toTimestamp(event.end);
            if (end <= start) throw new Error(`Event end must follow start: ${event.subject}`);
            if (start < this.rangeStart || start >= this.rangeEnd || end > this.rangeEnd) {
                ignored++;
                continue;
            }
            const resource = this.toGoogleEvent(event);
            const key = resource.extendedProperties.private.scheduleKey;
            if (keys.has(key)) throw new Error(`Duplicate schedule event: ${event.subject} at ${event.start}`);
            keys.add(key);
            desired.push({ event, resource, start, end, subject: event.subject,
                date: this.localDateTime(start).slice(0, 10), group: hash(event.group), key });
        }

        const existing = (await this.listEvents()).map(event => this.calendarRecord(event)).filter(Boolean);
        const pending = new Set(desired);
        const available = new Set(existing);
        const matches = new Map();
        const matchUnique = predicate => {
            const pairs = [];
            for (const item of pending) {
                const candidates = [...available].filter(record => predicate(item, record));
                if (candidates.length !== 1) continue;
                const record = candidates[0];
                if ([...pending].filter(other => predicate(other, record)).length === 1) pairs.push([item, record]);
            }
            for (const [item, record] of pairs) {
                matches.set(item, record);
                pending.delete(item);
                available.delete(record);
            }
        };
        matchUnique((item, record) => record.managed
            && record.event.extendedProperties.private.scheduleKey === item.key);
        matchUnique((item, record) => record.managed && item.subject === record.subject
            && item.group === record.group && item.date === record.date);
        matchUnique((item, record) => record.managed && item.group === record.group && item.start === record.start);
        matchUnique((item, record) => record.managed && item.subject === record.subject && item.group === record.group);
        matchUnique((item, record) => record.adoptable && item.subject === record.subject
            && item.start === record.start && item.end === record.end
            && (!record.group || record.group === item.group));

        const plan = { create: [], update: [], delete: [], unchanged: [], ignored };
        for (const item of desired) {
            const match = matches.get(item);
            if (!match) {
                plan.create.push({ event: item.event, resource: item.resource });
            } else if (this.needsUpdate(match.event, item.resource)) {
                item.resource.extendedProperties = {
                    ...match.event.extendedProperties,
                    private: { ...match.event.extendedProperties?.private, ...item.resource.extendedProperties.private },
                };
                plan.update.push({ eventId: match.event.id, event: item.event, resource: item.resource });
            } else {
                plan.unchanged.push({ eventId: match.event.id, event: item.event });
            }
        }
        for (const record of available) {
            if (record.managed) plan.delete.push({ eventId: record.event.id, subject: record.subject });
        }
        if (dryRun) return plan;
        // Deletions start only after all creates and updates succeed.
        for (const operation of plan.create) {
            const response = await this.calendar.events.insert({ calendarId: this.calendarId, requestBody: operation.resource });
            operation.eventId = response.data.id;
        }
        for (const operation of plan.update) {
            await this.calendar.events.patch({ calendarId: this.calendarId, eventId: operation.eventId, requestBody: operation.resource });
        }
        for (const operation of plan.delete) {
            await this.calendar.events.delete({ calendarId: this.calendarId, eventId: operation.eventId });
        }
        return plan;
    }
}

module.exports = GoogleCalendar;
