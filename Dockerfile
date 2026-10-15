FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv python3-pip fonts-dejavu fonts-liberation \
  && python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir openai-whisper \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV WHISPER_PYTHON=/opt/venv/bin/python
ENV WHISPER_MODEL=tiny
EXPOSE 10000
CMD ["npm", "start"]
