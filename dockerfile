FROM node:20-slim

RUN apt-get update && \
    apt-get install -y git curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user for Claude CLI (--dangerously-skip-permissions requires non-root)
RUN useradd -m appuser

# Install Claude Code CLI as appuser (correct home dir, correct PATH)
USER appuser
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV CLAUDE_CODE_SKIP_ONBOARDING=1
ENV PATH="/home/appuser/.local/bin:${PATH}"

# Skip onboarding (appuser's home)
RUN echo '{"hasCompletedOnboarding":true}' > /home/appuser/.claude.json

WORKDIR /app

# Copy bridge source from build context (no git clone needed)
COPY package*.json ./
COPY src ./src
RUN npm install

EXPOSE 3456 3458

CMD ["npm", "start"]
