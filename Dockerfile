# Run one container only, with /data on a persistent disk. See "Deploy on AWS, Azure or Google Cloud" in the README.
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 python3-venv && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
RUN npm ci
COPY apps apps
RUN npm run build
ENV NODE_ENV=production BASALT_DATA=/data BASALT_PYTHON=python3
VOLUME /data
EXPOSE 3000
WORKDIR /app/apps/web
CMD ["npx", "next", "start", "-H", "0.0.0.0"]
