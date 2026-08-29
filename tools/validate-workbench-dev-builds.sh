#!/bin/sh
set -eu

npm run build:workbench:firefox
npm run build:workbench:chromium
node tools/validate-workbench-dev-artifacts.js
