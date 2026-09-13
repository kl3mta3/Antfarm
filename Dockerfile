# Antfarm has no dependencies — the server is plain Node and the farm is plain
# JavaScript — so this is about as small as a container gets.
FROM node:20-alpine

WORKDIR /app
COPY index.html server.js house.js ./
COPY src ./src

# The house farm is saved here. Mount a volume so it survives the container.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

ENV NODE_ENV=production
ENV PORT=8173
ENV ANTFARM_DATA=/data/house.json
ENV ANTFARM_SESSION_HOURS=72
# ANTFARM_USER and ANTFARM_PASSWORD are deliberately NOT set here: an image
# should never carry a login. Pass them at run time (see docker-compose.yml and
# .env.example). Without them the farm still runs and can be watched, but
# nobody can sign in to tend it.

EXPOSE 8173
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://localhost:8173/api/house/status >/dev/null || exit 1

CMD ["node", "server.js"]
