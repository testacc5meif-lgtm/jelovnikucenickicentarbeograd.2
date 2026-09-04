# Слика за Render и сваки други хостинг који подиже контејнере.
#
# Обична Node окружења немају ни Tesseract ни poppler, а обрада јеловника
# тражи оба, па слика мора да их донесе са собом.

FROM node:24-slim

# tesseract-ocr: читање скенираних страна
# poppler-utils: pdftoppm, исцртавање страна PDF-а у слике
# ca-certificates: HTTPS ка сајту установе и ка бази
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tesseract-ocr \
        poppler-utils \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Зависности иду пре кода, да се њихов слој не гради поново при свакој
# измени изворних фајлова.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production \
    TESSDATA_DIR=/app/tessdata \
    TESSERACT_BIN=tesseract \
    TZ_NAME=Europe/Belgrade

# Језички подаци се скидају при градњи, а не при подизању, да прво
# покретање не чека мрежу. Узима се "best" издање, оно на коме је
# измерена тачност од 99 одсто; издање из Debian пакета је друго.
RUN node scripts/fetch-tessdata.js

# Апликација не уписује ништа у /app: привремене слике страна иду у
# системски temp. Ово је само да процес не ради са пуним правима.
RUN chown -R node:node /app
USER node

# Render сам додељује порт кроз PORT. Ова вредност је само за случај
# покретања слике ван њега.
ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/server.js"]
