FROM public.ecr.aws/docker/library/node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates

ARG LIB_BRANCH

WORKDIR /app
COPY package.json /app

RUN sed -i "s:staging:${LIB_BRANCH}:g" package.json

ARG PUPPETEER_SKIP_DOWNLOAD=true
ARG ssh_key
RUN apt-get install -y --no-install-recommends git ssh
RUN mkdir -p ~/.ssh
RUN echo "$ssh_key" > ~/.ssh/ssh_key
RUN chmod 600 ~/.ssh/ssh_key
RUN ssh-keyscan github.com >> ~/.ssh/known_hosts
RUN eval "$(ssh-agent -s)" && ssh-add ~/.ssh/ssh_key && npm i

COPY . /app

CMD ["npm","start"]
