const { google } = require('googleapis');
const { authenticate } = require('@google-cloud/local-auth');
const path = require('path');

const SCOPES = [
    'https://www.googleapis.com/auth/calendar'
];

class GoogleCalendar {
    constructor() {
        this.auth = null;
        this.calendar = null;
    }

    async init() {
        this.auth = await authenticate({
            keyfilePath: path.join(__dirname, 'credentials.json'),
            scopes: SCOPES,
        });
        this.calendar = google.calendar({ version: 'v3', auth: this.auth });
    }

    async listEvents(calendarId, timeMin, timeMax) {
        const res = await this.calendar.events.list({
            calendarId: calendarId,
            timeMin: timeMin,
            timeMax: timeMax,
            singleEvents: true,
            orderBy: 'startTime',
        });
        return res.data.items;
    }

    async matchEvents(calendarId, events) {
        const existingEvents = await this.listEvents(calendarId, events[0].start, events[events.length - 1].end);
        const matchedEvents = events.map(event => {
            const match = existingEvents.find(e => e.summary === event.subject && e.start.dateTime === event.start);
            return { ...event, googleEventId: match ? match.id : null };
        });
        return matchedEvents;
    }

}