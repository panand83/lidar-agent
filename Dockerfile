FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    KLA_CONFIG_DIR=/usr/src/lidar-config \
    KLA_LOG_DIR=/var/log/iclogs/kyra-lidar-agent \
    KLA_WEB_HOST=0.0.0.0 \
    KLA_WEB_PORT=8091

WORKDIR /opt/kyra-lidar-agent

RUN mkdir -p /usr/src/env/kyra-lidar-agent /usr/src/lidar-config /var/log/iclogs/kyra-lidar-agent

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py engine.py sources.py integrations.py processing.py ./
COPY static ./static
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8091
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["python", "app.py"]
