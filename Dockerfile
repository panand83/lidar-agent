FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    KLA_CONFIG_DIR=/usr/src/lidar-config \
    KLA_WEB_HOST=0.0.0.0 \
    KLA_WEB_PORT=8091

WORKDIR /opt/kyra-lidar-agent

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py engine.py sources.py ./
COPY static ./static

EXPOSE 8091
CMD ["python", "app.py"]
