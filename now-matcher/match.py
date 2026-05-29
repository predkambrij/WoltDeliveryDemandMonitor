import cv2
import sys
import os

SCREENSHOT = "/proj_root/"+os.environ.get("SCREENSHOT")
TEMPLATE   = os.environ.get("TEMPLATE")
THRESHOLD  = float(os.environ.get("THRESHOLD"))

screenshot = cv2.imread(SCREENSHOT)
template   = cv2.imread(TEMPLATE)

_, max_val, _, max_loc = cv2.minMaxLoc(cv2.matchTemplate(screenshot, template, cv2.TM_CCOEFF_NORMED))

if max_val < THRESHOLD:
    print(f"NO_MATCH confidence={max_val:.3f}")
    sys.exit(2)

y_top    = max_loc[1]
#y_bottom = y_top + template.shape[0]   # bottom edge = where bubble touches bar
#print(f"y_bottom={y_bottom}")          # main value — use this for demand level
print(f"y_top={y_top}")
print(f"confidence={max_val:.3f}")
