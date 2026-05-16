FROM node:20-slim

# Install FFmpeg for recording and snapshot extraction
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy source
COPY src/ ./src/

# Create data directories
RUN mkdir -p /app/data/recordings /app/data/snapshots

EXPOSE 3001

CMD ["node", "src/index.js"]
