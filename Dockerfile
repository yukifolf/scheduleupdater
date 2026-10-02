FROM node:24-alpine

# Install timezone support and configure default timezone
RUN apk add --no-cache tzdata
ENV TZ=Europe/Warsaw
ENV NODE_ENV=production

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source code
COPY calendar.js download.js filter.js main.js parser.js ./
COPY config/default-ini.json ./config/default-ini.json

# Create directories and ensure non-root 'node' user owns /app
RUN mkdir -p /app/tmp /app/config && chown -R node:node /app

USER node

CMD ["npm", "start"]
