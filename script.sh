#!/bin/bash -eEu
set -o pipefail
shopt -s inherit_errexit

scriptDir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
screenshotLogDir="$scriptDir/sslog"
demandImage="$scriptDir/demand.png"

runTime="$(date '+%Y-%m-%d_%H-%M-%S')"
mkdir -p "$scriptDir/logs"
debugLogFile="/dev/null" # "$scriptDir/logs/log_ocr_debug_${runTime}.log"
logOcrFile="$scriptDir/logs/log_ocr_${runTime}.log"
logMatchFile="$scriptDir/logs/log_match_${runTime}.log"
last_ocr_demand_amount=""
last_template_match=""


function capture() {
    if ! capture_demand_image; then
        adb start-server >/dev/null 2>> "$debugLogFile" || true

        if ! capture_demand_image; then
            printf "%s\tskip: couldn't capture screencap\n" "$demand_time"
            sleep 1m
            return 1
        fi
    fi
    return 0
}

function capture_demand_image() {
    local tmpImage="$(mktemp /tmp/demand.XXXXXX.png)"

    if timeout 20s adb exec-out screencap -p > "$tmpImage" 2>> "$debugLogFile" && [[ -s "$tmpImage" ]]; then
        mv "$tmpImage" "$demandImage"
        return 0
    fi

    rm -f "$tmpImage"
    return 1
}

function process_ocr() {
    if ! demand_amount=$(tesseract "$demandImage" stdout 2>> "$debugLogFile" | awk '/Delivery demand/ {print $NF}'); then
        printf "%s\tskip: couldn't tesseract\n" "$demand_time"
        return 1
    fi

    if [[ -z "$demand_amount" ]]; then
        printf '%s\tskip: zero amount\n' "$demand_time"
        return 1
    fi

    if [[ "$demand_amount" == *$'\n'* ]]; then
        printf '%s\tskip: multiple OCR matches\n' "$demand_time"
        return 1
    fi

    if [[ "$demand_amount" != "$last_ocr_demand_amount" ]]; then
        printf '%s\t%s\n' "$demand_time" "$demand_amount" >> "$logOcrFile"
        last_ocr_demand_amount="$demand_amount"
    fi
    return 0
}

function process_match_template() {
    if template_match=$(docker compose -f now-matcher/docker-compose.yml --progress=quiet run --rm matcher</dev/null); then
        local y_top="$(awk -F= '$1 == "y_top" {print $2}' <<< "$template_match")"
        local confidence="$(awk -F= '$1 == "confidence" {print $2}' <<< "$template_match")"

        if [[ -z "$y_top" || -z "$confidence" ]]; then
            printf '%s\tskip: malformed template matcher output\n' "$demand_time"
            return 1
        fi

        local match_value="${y_top}:${confidence}"
        if [[ "$match_value" != "$last_template_match" ]]; then
            printf '%s\ty_top=%s\tconfidence=%s\n' "$demand_time" "$y_top" "$confidence" >> "$logMatchFile"
            last_template_match="$match_value"
        fi
    else
        local status=$?
        if [[ "$status" -eq 2 ]]; then
            printf '%s\tskip: no template match\n' "$demand_time"
            return 0
        fi

        printf '%s\tskip: template matcher failed with status %s\n' "$demand_time" "$status"
        return "$status"
    fi
}

function main() {
    adb start-server >/dev/null 2>> "$debugLogFile" || true

    while true; do
        demand_time=$(date '+%Y-%m-%d_%H-%M-%S')

        if ! capture; then
            continue
        fi

        if ! process_match_template; then
            continue
        fi

        if ! process_ocr; then
            sleep 1m
            continue
        fi

        # archive
        cp "$demandImage" "$screenshotLogDir/demand_${demand_time}.png"

        sleep 1m
    done
}

function replay() {
    local screenshot screenshotName

    while IFS= read -r screenshot; do
        screenshotName="$(basename "$screenshot")"
        demand_time="${screenshotName#demand_}"
        demand_time="${demand_time%.png}"

        cp "$screenshot" "$demandImage"

        if ! process_match_template; then
            continue
        fi

        if ! process_ocr; then
            continue
        fi
    done < <(find "$screenshotLogDir" -maxdepth 1 -type f -name 'demand_*.png' | sort)
}

main
#replay
