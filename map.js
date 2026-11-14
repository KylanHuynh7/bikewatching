// Import Mapbox and D3 as ESM modules
import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

// Check that Mapbox GL JS is loaded
console.log('Mapbox GL JS Loaded:', mapboxgl);

// Set your Mapbox access token here
mapboxgl.accessToken = 'pk.eyJ1Ijoia3lsYW4taHV5bmgiLCJhIjoiY213ZnVkbzE4MGJqazJ6b2R3NDRiODVycSJ9._MlmkHAAfAfnNapoWTCuNA';

const STATIONS_URL = 'https://dsc106.com/labs/lab07/data/bluebikes-stations.json';
const TRIPS_URL = 'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv';
const BOSTON_LANES_URL =
  'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson';
const CAMBRIDGE_LANES_URL =
  'https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson';

// Initialize the map
const map = new mapboxgl.Map({
  container: 'map', // ID of the div where the map will render
  style: 'mapbox://styles/mapbox/streets-v12', // Map style
  center: [-71.09415, 42.36027], // [longitude, latitude]
  zoom: 12, // Initial zoom level
  minZoom: 5, // Minimum allowed zoom
  maxZoom: 18, // Maximum allowed zoom
});

// The map only re-measures itself when the window resizes, so also tell it
// when its container changes size (e.g. once fonts load and the header settles)
new ResizeObserver(() => map.resize()).observe(map.getContainer());

// Step 5.4: trips pre-sorted into one bucket per minute of the day, so
// moving the slider only looks at ~120 buckets instead of all 260K trips
let departuresByMinute = Array.from({ length: 1440 }, () => []);
let arrivalsByMinute = Array.from({ length: 1440 }, () => []);

// Step 6.1: departures / total traffic, snapped to three values
let stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);

/* ── helpers (global, so map interactions can use them) ──────────── */

// Convert a station's lon/lat to pixel coordinates on the map
function getCoords(station) {
  const point = new mapboxgl.LngLat(+station.lon, +station.lat);
  const { x, y } = map.project(point);
  return { cx: x, cy: y };
}

function formatTime(minutes) {
  const date = new Date(0, 0, 0, 0, minutes); // Set hours & minutes
  return date.toLocaleString('en-US', { timeStyle: 'short' }); // HH:MM AM/PM
}

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

// All trips within 60 minutes before or after `minute`
function filterByMinute(tripsByMinute, minute) {
  if (minute === -1) {
    return tripsByMinute.flat(); // No filtering, return all trips
  }

  // Normalize both min and max minutes to the valid range [0, 1439]
  let minMinute = (minute - 60 + 1440) % 1440;
  let maxMinute = (minute + 60) % 1440;

  // Handle time filtering across midnight
  if (minMinute > maxMinute) {
    let beforeMidnight = tripsByMinute.slice(minMinute);
    let afterMidnight = tripsByMinute.slice(0, maxMinute);
    return beforeMidnight.concat(afterMidnight).flat();
  } else {
    return tripsByMinute.slice(minMinute, maxMinute).flat();
  }
}

// Adds arrivals, departures and totalTraffic to every station
function computeStationTraffic(stations, timeFilter = -1) {
  const departures = d3.rollup(
    filterByMinute(departuresByMinute, timeFilter),
    (v) => v.length,
    (d) => d.start_station_id,
  );

  const arrivals = d3.rollup(
    filterByMinute(arrivalsByMinute, timeFilter),
    (v) => v.length,
    (d) => d.end_station_id,
  );

  return stations.map((station) => {
    let id = station.short_name;
    station.arrivals = arrivals.get(id) ?? 0;
    station.departures = departures.get(id) ?? 0;
    station.totalTraffic = station.arrivals + station.departures;
    return station;
  });
}

// A station with no trips has no ratio, so it is shown as balanced
function departureRatio(station) {
  return station.totalTraffic > 0
    ? stationFlow(station.departures / station.totalTraffic)
    : 0.5;
}

function tooltipText(station) {
  return `${station.name}: ${station.totalTraffic} trips (${station.departures} departures, ${station.arrivals} arrivals)`;
}

/* ── everything below needs the map to be ready ──────────────────── */

map.on('load', async () => {
  // Step 2: bike lanes. One style object shared by both cities.
  const bikeLaneStyle = {
    'line-color': '#32D400',
    'line-width': 3,
    'line-opacity': 0.5,
  };

  map.addSource('boston_route', { type: 'geojson', data: BOSTON_LANES_URL });
  map.addLayer({
    id: 'bike-lanes-boston',
    type: 'line',
    source: 'boston_route',
    paint: bikeLaneStyle,
  });

  map.addSource('cambridge_route', { type: 'geojson', data: CAMBRIDGE_LANES_URL });
  map.addLayer({
    id: 'bike-lanes-cambridge',
    type: 'line',
    source: 'cambridge_route',
    paint: bikeLaneStyle,
  });

  // Step 3.1 + 4.1: station list and trip data
  let jsonData;
  let trips;
  try {
    jsonData = await d3.json(STATIONS_URL);

    trips = await d3.csv(TRIPS_URL, (trip) => {
      trip.started_at = new Date(trip.started_at);
      trip.ended_at = new Date(trip.ended_at);

      // Step 5.4: file each trip under the minute it started and ended
      departuresByMinute[minutesSinceMidnight(trip.started_at)].push(trip);
      arrivalsByMinute[minutesSinceMidnight(trip.ended_at)].push(trip);

      return trip;
    });
  } catch (error) {
    console.error('Error loading Bluebikes data:', error);
    return;
  }

  // Step 4.2: traffic per station (no time filter yet)
  const stations = computeStationTraffic(jsonData.data.stations);

  // Step 4.3: square-root scale, so circle AREA is proportional to traffic
  const radiusScale = d3
    .scaleSqrt()
    .domain([0, d3.max(stations, (d) => d.totalTraffic)])
    .range([0, 25]);

  // Step 3.3: one circle per station on the SVG overlay
  const svg = d3.select('#map').select('svg');

  const circles = svg
    .selectAll('circle')
    .data(stations, (d) => d.short_name) // key, so circles are reused on update
    .enter()
    .append('circle')
    .attr('r', (d) => radiusScale(d.totalTraffic))
    .style('--departure-ratio', (d) => departureRatio(d))
    .each(function (d) {
      // Step 4.4: <title> gives a browser tooltip
      d3.select(this).append('title').text(tooltipText(d));
    });

  // Keep the circles lined up with the map as it moves
  function updatePositions() {
    circles
      .attr('cx', (d) => getCoords(d).cx)
      .attr('cy', (d) => getCoords(d).cy);
  }

  updatePositions();
  map.on('move', updatePositions);
  map.on('zoom', updatePositions);
  map.on('resize', updatePositions);
  map.on('moveend', updatePositions);

  // Step 5.2: the time slider
  const timeSlider = document.getElementById('time-slider');
  const selectedTime = document.getElementById('selected-time');
  const anyTimeLabel = document.getElementById('any-time');

  // Step 5.3: recompute traffic for the selected time and redraw
  function updateScatterPlot(timeFilter) {
    const filteredStations = computeStationTraffic(stations, timeFilter);

    // fewer trips are shown when filtering, so let the circles grow
    timeFilter === -1 ? radiusScale.range([0, 25]) : radiusScale.range([3, 50]);

    circles
      .data(filteredStations, (d) => d.short_name)
      .join('circle')
      .attr('r', (d) => radiusScale(d.totalTraffic))
      .style('--departure-ratio', (d) => departureRatio(d))
      .select('title')
      .text((d) => tooltipText(d));
  }

  function updateTimeDisplay() {
    let timeFilter = Number(timeSlider.value);

    if (timeFilter === -1) {
      selectedTime.textContent = '';
      selectedTime.style.display = 'none';
      anyTimeLabel.style.display = 'block';
    } else {
      selectedTime.textContent = formatTime(timeFilter);
      selectedTime.style.display = 'block';
      anyTimeLabel.style.display = 'none';
    }

    updateScatterPlot(timeFilter);
  }

  timeSlider.addEventListener('input', updateTimeDisplay);
  updateTimeDisplay();
});
