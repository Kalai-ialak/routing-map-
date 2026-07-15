# Multi-mode route map (Flask + Leaflet)

Ithu oru practice project - map la bus, train, walking, ship, flight routes kaatura.

## Free options used (no API key vendum)
- **Map tiles**: OpenStreetMap (free)
- **Bus / Train / Walking routes**: OSRM public demo server (free, road-based routing)
- **Ship / Flight routes**: Straight-line path — free ship/flight routing API illa, so idha approximate line drawing panniruken

## Setup (local server la run panna)

1. Terminal open pannu, project folder ku po:
   ```
   cd route-map-project
   ```

2. Virtual environment create pannu (optional but recommended):
   ```
   python -m venv venv
   source venv/bin/activate      # Windows: venv\Scripts\activate
   ```

3. Requirements install pannu:
   ```
   pip install -r requirements.txt
   ```

4. Server start pannu:
   ```
   python app.py
   ```

5. Browser la open pannu:
   ```
   http://127.0.0.1:5000
   ```

## Eppadi use panradhu
1. Map mel oru click pannu -> start point set aagum
2. Innoru click pannu -> end point set aagum
3. Mode dropdown la (Walking / Bus / Train / Ship / Flight) select pannu
4. "Find route" click pannu -> route line map la varum, different color/dash style per mode
5. "Reset" click panni marupadiyum try pannalam

## Next steps (nee vera add pannalam)
- Real-time bus/train GPS data (unga area transport API irundha)
- Multiple stops (multi-leg route)
- Save/share route link
- Better ship/flight route (curved great-circle line - `Leaflet.Geodesic` plugin use pannalam)
