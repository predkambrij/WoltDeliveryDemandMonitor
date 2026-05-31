# Overview

This is mostly a personal project, but it might also come in handy for somebody else. The goal is to get some clues when it makes sense to get out and do deliveries - and actually be getting tasks. I'm not a professional delivery guy. I do this sometimes, mostly as a paid workout.

This project collects data from Wolt's courier app (taking periodic screenshots using adb) and then uses OCR and OpenCV's matchTemplate to extract information about current demand. It also collects weather data and displays it as a web page for the selected day. I'm mostly interested in the day's peak and which day of the week makes the most sense (which must also work with my schedule).

Possible improvements:
- collect "Earn extra" - boosts and display along (announcement time, period of "Earn extra", and an extra % probably has some influence) of the demand for and around that period.

Other notes:
- UI and UI test are mostly vibe coded, so code quality is slightly lower than what's needed to receive the Nobel price.
- App "Keep Screen On" will keep the screen awake

UI screenshot for a busy hot Saturday:
![screenshot](docs/Screenshot_2026-05-31_01-14-32.png)



# Tools needed on host system (tested on ubuntu 26.04)
```bash
sudo apt install -y tesseract-ocr imagemagick adb tmux
# ubuntu 26.04
sudo apt install android-udev-rules
# ubuntu 24.04
sudo udevadm control --reload-rules
sudo udevadm trigger
# test connection
adb kill-server
adb start-server
adb devices # confirm on the phone
```

# Pollers
```bash
# periodic collecting of text and visual clues of current delivery demand
./script.sh
# needed to run once a day, to get sunrise, sunset and hourly weather forecast for current day
./weather.sh daily
# periodic collection of current weather (15 min increments)
./weather.sh main
```

# Cron
Easiest way is to setup that through cron
```bash
cat /etc/cron.d/user
0 6 * * *   user /usr/bin/tmux new-session -d -s script_sh "cd /home/user/devbox_pr/repos/WoltDeliveryDemandMonitor; ./script.sh main_with_start_and_end"
59 5 * * *   user /usr/bin/tmux new-session -d -s weather_sh_daily "cd /home/user/devbox_pr/repos/WoltDeliveryDemandMonitor; ./weather.sh daily"
46 3 * * *   user /usr/bin/tmux new-session -d -s weather_sh "cd /home/user/devbox_pr/repos/WoltDeliveryDemandMonitor; ./weather.sh main_with_start_and_end"
```

# now-matcher
Matches exact position of the selected template (cropped section of the image). The output is y axis position of the match (if confidence is big enough).
```bash
# build
docker compose -f now-matcher/docker-compose.yml build
# match default image - demand.png
docker compose -f now-matcher/docker-compose.yml --progress=quiet run --rm matcher
# match selected image - in this case sslog/demand_2026-05-30_00-23-22.png
docker compose -f now-matcher/docker-compose.yml --progress=quiet run --rm -e SCREENSHOT=sslog/demand_2026-05-30_00-23-22.png matcher
```

# UI
Visually displays selected date (demand along with weather info)
```bash
docker compose -f ui/docker-compose.yml up -t=0 -d --build
```

# UI test
Uses puppeteer to get UI's rendering (mostly for AI to get visual feedback)
```bash
docker compose -f ui_test/docker-compose.yml run --build --rm puppeteer
# update deps
docker compose -f ui_test/docker-compose.yml run --build --rm update-deps
```


# Calibrating values for my device

## level 0 (low - zero)
```bash
$ docker compose -f now-matcher/docker-compose.yml --progress=quiet run --rm -e SCREENSHOT=sslog/demand_2026-05-30_00-55-51.png matcher
y_top=830
confidence=0.993
```

## level 1 (low - lowest)
```bash
$ docker compose -f now-matcher/docker-compose.yml --progress=quiet run --rm -e SCREENSHOT=sslog/demand_2026-05-30_00-48-45.png matcher
y_top=805
confidence=0.982
```

## level 2 (low - medium)
```bash
$ docker compose -f now-matcher/docker-compose.yml --progress=quiet run --rm -e SCREENSHOT=sslog/demand_2026-05-30_00-38-36.png matcher
y_top=779
confidence=0.982
```

## level 3 (low - highest)
```bash
$ docker compose -f now-matcher/docker-compose.yml --progress=quiet run --rm -e SCREENSHOT=sslog/demand_2026-05-30_00-23-22.png matcher
y_top=754
confidence=0.992
```

## level 4 (medium - lowest)
```bash
$ docker compose -f now-matcher/docker-compose.yml --progress=quiet run --rm -e SCREENSHOT=sslog/demand_2026-05-30_00-08-09.png matcher
y_top=729
confidence=0.966
```

## level 5 (medium - medium)
```bash
$ docker compose -f now-matcher/docker-compose.yml --progress=quiet run --rm -e SCREENSHOT=sslog/demand_2026-05-29_23-48-52.png matcher
y_top=704
confidence=0.993
```

## level 6 (medium - highest)
```bash
$ docker compose -f now-matcher/docker-compose.yml --progress=quiet run --rm -e SCREENSHOT=sslog/demand_2026-05-29_23-28-34.png matcher
y_top=679
confidence=0.982
```

## level 7 (high - lowest) - phone 2
```bash
docker compose -f now-matcher/docker-compose.yml --progress=quiet run --rm -e SCREENSHOT=sslog/demand_2026-05-30_21-39-51.png matcher
y_top=650
confidence=0.982
```

## level 8 (high - medium) - phone 2
```bash
docker compose -f now-matcher/docker-compose.yml --progress=quiet run --rm -e SCREENSHOT=sslog/demand_2026-05-30_21-45-00.png matcher
y_top=625
confidence=0.992
```

## level 9 (high - highest) - phone 2
```bash
docker compose -f now-matcher/docker-compose.yml --progress=quiet run --rm -e SCREENSHOT=sslog/demand_2026-05-30_21-29-34.png matcher
y_top=600
confidence=0.966
```

##  phone 2 Starts in

## level 4 (medium - lowest)
```bash
docker compose -f now-matcher/docker-compose.yml --progress=quiet run --rm -e SCREENSHOT=sslog/demand_2026-05-31_11-12-19.png matcher
y_top=584
confidence=0.966
```

## level 5 (medium - medium)
```bash
docker compose -f now-matcher/docker-compose.yml --progress=quiet run --rm -e SCREENSHOT=sslog/demand_2026-05-31_11-07-09.png matcher
y_top=559
confidence=0.958
```

## level 6 (medium - highest)
```bash
docker compose -f now-matcher/docker-compose.yml --progress=quiet run --rm -e SCREENSHOT=sslog/demand_2026-05-31_11-18-30.png matcher
y_top=534
confidence=0.947
```

## level 7 (high - lowest)
```bash
docker compose -f now-matcher/docker-compose.yml --progress=quiet run --rm -e SCREENSHOT=sslog/demand_2026-05-31_11-27-48.png matcher
y_top=508
confidence=0.955
```

## level 8 (high - medium)
```bash
docker compose -f now-matcher/docker-compose.yml --progress=quiet run --rm -e SCREENSHOT=sslog/demand_2026-05-31_12-01-51.png matcher
y_top=490
confidence=0.963
```

## level 9 (high - highest)
```bash
docker compose -f now-matcher/docker-compose.yml --progress=quiet run --rm -e SCREENSHOT=sslog/demand_2026-05-31_12-12-11.png matcher
y_top=489
confidence=0.966
```


## Summary (phone2 has values shifted by 3, Starts in shifts by 142)
```
603 or 600 or 489 - level 9 (111)
628 or 625 or 490 - level 8 (135)
653 or 650 or 508 - level 7 (142)
679 or 676 or 534 - level 6 (142)
704 or 701 or 559 - level 5 (142)
729 or 726 or 584 - level 4 (142)
754 or 751 or 609 - level 3 (xxx)
779 or 776 or 634 - level 2 (xxx)
805 or 802 or 660 - level 1 (xxx)
830 or 827 or 685 - level 0 (xxx)
```

