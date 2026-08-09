// ======================================================
// CHART UTILITIES & INITIALIZATION
// ======================================================
let chartWindowStart = 0;
let chartBuckets25 = Array(24).fill(null);
let chartBuckets10 = Array(24).fill(null);

function getChartWindowStart(baseDate = new Date()) {
  const anchor = new Date(baseDate);
  anchor.setMinutes(0, 0, 0);
  anchor.setHours(anchor.getHours() - 23);
  return anchor.getTime();
}

function getChartLabels() {
  const start = chartWindowStart;
  return Array.from({ length: 24 }, (_, i) => {
    const t = new Date(start + i * 60 * 60 * 1000);
    return t.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  });
}

function getChartBucketIndex(timestamp) {
  const ts = new Date(timestamp).getTime();
  if (Number.isNaN(ts)) return -1;
  const start = chartWindowStart;
  const end = start + (24 * 60 * 60 * 1000);
  if (ts >= end || ts < start) return -1;
  const index = Math.floor((ts - start) / (60 * 60 * 1000));
  return index <= 23 ? index : -1;
}

function initChart() {
  const ctx = document.getElementById('mainChart').getContext('2d');
  chartWindowStart = getChartWindowStart();
  const labels = getChartLabels();
  chartBuckets25 = Array(24).fill(null);
  chartBuckets10 = Array(24).fill(null);

  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'PM2.5 (μg/m³)',
          data: [...chartBuckets25],
          borderColor: '#f97316',
          backgroundColor: 'rgba(249,115,22,0.08)',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.4,
          fill: true,
        },
        {
          label: 'PM10 (μg/m³)',
          data: [...chartBuckets10],
          borderColor: '#eab308',
          backgroundColor: 'rgba(234,179,8,0.06)',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.4,
          fill: true,
        }
      ]
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      animation: { duration: 400 },
      plugins: {
        legend: {
          labels: {
            color: '#64748b',
            font: { family: 'JetBrains Mono', size: 10 },
            boxWidth: 12,
          }
        },
        tooltip: {
          backgroundColor: '#0d1520',
          borderColor: '#1a2d44',
          borderWidth: 1,
          titleColor: '#64748b',
          bodyColor: '#e2e8f0',
          titleFont: { family: 'JetBrains Mono', size: 10 },
          bodyFont: { family: 'Barlow Condensed', size: 12 },
        }
      },
      scales: {
        x: {
          ticks: { color: '#64748b', font: { family: 'JetBrains Mono', size: 9 }, maxTicksLimit: 8 },
          grid: { color: 'rgba(26,45,68,0.8)' },
        },
        y: {
          ticks: { color: '#64748b', font: { family: 'JetBrains Mono', size: 9 } },
          grid: { color: 'rgba(26,45,68,0.8)' },
          title: { display: true, text: 'μg/m³', color: '#64748b', font: { size: 10 } }
        }
      }
    }
  });
}

function switchChart(mode, event) {
  currentChartMode = mode;
  document.querySelectorAll('.chart-tab').forEach(t => t.classList.remove('active'));
  const target = event?.currentTarget || event?.target || document.querySelector(`.chart-tab[onclick*="${mode}"]`);
  if (target) target.classList.add('active');
  if (!chart) return;
  chart.data.datasets[0].hidden = (mode === 'pm10');
  chart.data.datasets[1].hidden = (mode === 'pm25');
  chart.update();
}
