# Antfarm has no dependencies — the server is plain Node and the farm is plain
# JavaScript — so this is about as small as a container gets.
FROM node:20-alpine

WORKDIR /app
COPY index.html style.css server.js house.js ./
COPY src ./src
COPY landing ./landing

# The house farm is saved here. Mount a volume so it survives the container.
# su-exec lets the entrypoint fix /data's ownership as root and then run the
# server as the unprivileged node user (see docker-entrypoint.sh).
RUN apk add --no-cache su-exec && mkdir -p /data/antfarm && chown node:node /data/antfarm
COPY docker-entrypoint.sh /usr/local/bin/antfarm-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/antfarm-entrypoint.sh && chmod +x /usr/local/bin/antfarm-entrypoint.sh
VOLUME /data

ENV NODE_ENV=production
ENV PORT=8173
ENV ANTFARM_DATA=/data/antfarm/house.json
ENV ANTFARM_SESSION_HOURS=72
# ANTFARM_USER and ANTFARM_PASSWORD are deliberately NOT set here: an image
# should never carry a login. Pass them at run time (see docker-compose.yml and
# .env.example). Without them the farm still runs and can be watched, but
# nobody can sign in to tend it.

EXPOSE 8173
# No "USER node" here: the entrypoint starts as root only to make /data
# writable, then runs the server as node.

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://localhost:8173/health >/dev/null || exit 1

ENTRYPOINT ["antfarm-entrypoint.sh"]
CMD ["node", "server.js"]
