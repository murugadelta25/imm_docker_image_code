# syntax=docker/dockerfile:1
# IMM EAP PMS — single image: nginx (UI) + uvicorn (API)
# Build:
#   NodePort / root URL:
#     docker build -t imm-pms:v1.0.0 .
#   App Management Ingress path /app/imm-pms/v1/imm-pms/:
#     docker build --build-arg VITE_BASE=/app/imm-pms/v1/imm-pms/ -t imm-pms:v1.0.0 .

ARG NODE_IMAGE=node:20-bookworm-slim
ARG PYTHON_IMAGE=python:3.12-slim-bookworm

# ---------- Frontend build ----------
FROM ${NODE_IMAGE} AS frontend-build
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# App Management Ingress basename (must end with /). Use "/" for NodePort.
ARG VITE_BASE=/
ENV VITE_BASE=${VITE_BASE}
RUN npm run build

# ---------- Runtime ----------
FROM ${PYTHON_IMAGE} AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      nginx \
      curl \
      wget \
      libglib2.0-0 \
      libsm6 \
      libxext6 \
      libxrender1 \
      libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/nginx/sites-enabled/default

WORKDIR /app

# Python deps
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --upgrade pip && pip install -r /app/backend/requirements.txt

# Application code
COPY backend/ /app/backend/
# Ensure static upload dirs exist
RUN mkdir -p \
      /app/backend/static/machines \
      /app/backend/static/factory \
      /app/backend/static/parts \
      /app/backend/static/work-instructions \
      /app/backend/static/operator-sessions \
      /app/backend/static/operator-reference

# Frontend dist → nginx html (Vite may emit under a nested base path)
COPY --from=frontend-build /src/frontend/dist /usr/share/nginx/html

COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Default env (override at runtime / ConfigMap — never bake secrets into image)
ENV DATABASE_URL="" \
    SECRET_KEY="changeme" \
    ACCESS_TOKEN_EXPIRE_MINUTES="480" \
    NODE_RED_URL="http://127.0.0.1:1880" \
    NODE_RED_WEBHOOK_SECRET="" \
    MACHINE_STATUS_PUSH_SECRET="" \
    CORS_ORIGINS="*" \
    PLATFORM_ADMIN_USERNAME="platform_admin" \
    PLATFORM_ADMIN_PASSWORD="ChangeMe-Platform-2026!"

EXPOSE 18080
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:18080/health || exit 1

WORKDIR /app/backend
ENTRYPOINT ["/entrypoint.sh"]