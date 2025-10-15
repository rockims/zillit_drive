FROM public.ecr.aws/docker/library/node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates

ARG LIB_BRANCH

# Chrome instalation
RUN curl -LO  https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
RUN apt-get install -y ./google-chrome-stable_current_amd64.deb
RUN rm google-chrome-stable_current_amd64.deb

WORKDIR /app
COPY package.json /app

RUN sed -i "s:staging:${LIB_BRANCH}:g" package.json

ARG PUPPETEER_SKIP_DOWNLOAD=true
ARG ssh_key
RUN apt-get install -y --no-install-recommends git ssh openssh-client
RUN mkdir -p ~/.ssh
RUN echo "$ssh_key" > ~/.ssh/ssh_key
RUN chmod 600 ~/.ssh/ssh_key
RUN ssh-keyscan github.com >> ~/.ssh/known_hosts
RUN eval "$(ssh-agent -s)" && ssh-add ~/.ssh/ssh_key && npm i

COPY . /app

CMD ["npm","start"]
