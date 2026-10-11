#!/bin/sh
# Runs the tests against the plugin. `claude plugin test` runs the tests found under the plugin
# folder, and the tests live outside it so that they are not part of what users install. This
# copies plugin/ and tests/ into a temporary folder, points the tests' imports at the copy, and
# runs them there. Usage: scripts/test.sh
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp -R "$root/plugin/." "$tmp/"
rm -rf "$tmp/tests"
cp -R "$root/tests" "$tmp/tests"
find "$tmp/tests" -name '*.ts' -exec sed -i.orig "s#'\.\./plugin/hooks/#'../hooks/#g" {} +
find "$tmp/tests" -name '*.orig' -exec rm {} +
claude plugin test "$tmp"
