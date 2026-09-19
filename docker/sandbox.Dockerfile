FROM node:22-bookworm
RUN apt-get update && apt-get install -y git python3 docker.io && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
CMD ["bash"]
