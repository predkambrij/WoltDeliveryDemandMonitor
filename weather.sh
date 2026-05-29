#!/bin/bash -eEu
set -o pipefail
shopt -s inherit_errexit

scriptDir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
runTime="$(date '+%Y-%m-%d')"

latitude="46.0569"
longitude="14.5058"
timezone="Europe/Ljubljana"

currentWeatherLogFile="$scriptDir/logs/log_weather_current_${runTime}.jsonl"
hourlyForecastLogFile="$scriptDir/logs/log_weather_hourly_forecast_${runTime}.jsonl"
sunEventsLogFile="$scriptDir/logs/log_weather_sun_events_${runTime}.jsonl"

weatherApiUrl="https://api.open-meteo.com/v1/forecast"
sunApiUrl="https://api.sunrise-sunset.org/json"

function log_current_weather() {
    local weatherData

    weatherData="$(curl -fsS --get "$weatherApiUrl" \
        --data-urlencode "latitude=$latitude" \
        --data-urlencode "longitude=$longitude" \
        --data-urlencode "timezone=$timezone" \
        --data-urlencode "forecast_days=1" \
        --data-urlencode "current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m")" || {
        printf 'Failed to fetch current weather data\n' >&2
        exit 1
    }

    jq -c . <<< "$weatherData" >> "$currentWeatherLogFile"
}

function log_hourly_forecast() {
    local weatherData

    weatherData="$(curl -fsS --get "$weatherApiUrl" \
        --data-urlencode "latitude=$latitude" \
        --data-urlencode "longitude=$longitude" \
        --data-urlencode "timezone=$timezone" \
        --data-urlencode "forecast_days=1" \
        --data-urlencode "hourly=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation_probability,precipitation,rain,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m")" || {
        printf 'Failed to fetch hourly forecast data\n' >&2
        exit 1
    }

    jq -c . <<< "$weatherData" >> "$hourlyForecastLogFile"
}

function log_sun_events() {
    local sunData

    sunData="$(curl -fsS --get "$sunApiUrl" \
        --data-urlencode "lat=$latitude" \
        --data-urlencode "lng=$longitude" \
        --data-urlencode "date=today" \
        --data-urlencode "formatted=0" \
        --data-urlencode "tzid=$timezone")" || {
        printf 'Failed to fetch sun event data\n' >&2
        exit 1
    }

    jq -c . <<< "$sunData" >> "$sunEventsLogFile"
}

function main() {
    local mode="${1:-}"

    if [[ "$mode" == "daily" ]]; then
        log_hourly_forecast
        log_sun_events
    elif [[ "$mode" == "mon" ]]; then
        while true; do
            log_current_weather
            sleep 15m
        done
    else
        printf 'Usage: %s <daily|mon>\n' "$0" >&2
        exit 1
    fi
}

main "$@"
