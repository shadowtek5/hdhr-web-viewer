FROM python:3.12-slim

# ffmpeg (with libx264) does the MPEG-2 -> HLS transcoding
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.py ./
COPY static ./static

# Saved devices + signal-survey results live on this volume
ENV HDHR_DATA_DIR=/data \
    HDHR_PORT=8090
VOLUME /data

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD python -c "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('HDHR_PORT','8090')+'/',timeout=4)" || exit 1

CMD ["python", "server.py"]
