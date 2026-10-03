#!/usr/bin/env bash
# usage: tagreader.sh <extension-name> <module...>   (run from project/)
# Runs the core-only reader with the spike project's LEAN_PATH (from `lake env`), no lake involved.
set -u
export PATH=$HOME/.elan/bin:$PATH
LEAN_PATH="$(lake env printenv LEAN_PATH)" exec ../tagreader/.lake/build/bin/tagreader "$@"
