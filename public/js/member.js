// ======================================================
// MEMBER DATA TABLE, LOCATIONS, ALERTS
// ======================================================

function setMemberDataMessage(message, isError = false) {
  const el = document.getElementById('memberDataMessage');
  if (!el) return;
  el.textContent = message;
  el.style.color = isError ? '#ef4444' : '#64748b';
}

function setLocationMessage(message, isError = false) {
  const el = document.getElementById('locationMessage');
  if (!el) return;
  el.textContent = message;
  el.style.color = isError ? '#ef4444' : '#64748b';
}

function getDisplayDeviceName(deviceId) {
  return deviceId ? 'Alat Aktif' : '';
}

const ACTIVE_LOCATION_NAME = 'Wilayah Tambang Batu Bara (PT SEMBADA COAL)';
const ACTIVE_LOCATION_LAT = -6.1306042;
const ACTIVE_LOCATION_LNG = 106.2601798;

function getMemberAqiSummary(row = {}) {
  const pm25 = Number(row.pm25) || 0;
  const pm10 = Number(row.pm10) || 0;
  const r25 = calcAQI(pm25, PM25_BREAKPOINTS);
  const r10 = calcAQI(pm10, PM10_BREAKPOINTS);
  const finalAqi = Math.max(r25.aqi, r10.aqi);
  const dominant = finalAqi === r25.aqi ? r25 : r10;
  const dominantParam = finalAqi === r25.aqi ? 'PM2.5' : 'PM10';

  return {
    finalAqi,
    category: dominant.bp.cat,
    color: dominant.bp.color,
    dominantParam
  };
}

function renderMemberDataTable(rows = []) {
  const tbody = document.getElementById('memberDataTableBody');
  if (!tbody) return;

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="11" class="admin-empty">Belum ada data</td></tr>';
    return;
  }

  const isAdmin = currentRole === 'admin';
  const isSelectMode = document.querySelector('.checkbox-column').style.display !== 'none';

  tbody.innerHTML = rows.map((row, index) => {
    const date = typeof row.timestamp === 'string' && row.timestamp.includes('T')
      ? row.timestamp.split('T')[0]
      : new Date(row.timestamp || Date.now()).toISOString().split('T')[0];

    const summary = getMemberAqiSummary(row);
    const statusColor = summary.color;
    
    // Format arah angin
    const windDirection = row.arah_angin !== undefined ? `${row.arah_angin}°` : '-';
    const windSpeed = row.kecepatan_angin !== undefined ? `${row.kecepatan_angin} m/s` : '-';

    const checkboxCell = isSelectMode 
      ? `<td class="checkbox-column">
          <input type="checkbox" class="row-checkbox" data-device="${row.device}" data-entry-key="${row.entryKey}" data-index="${index}">
        </td>`
      : '';

    const actionCell = isSelectMode
      ? `<td></td>`
      : `<td class="member-table-actions">
          <button class="member-table-btn" data-action="download-row" data-device="${row.device}" data-date="${date}">↓ CSV</button>
          ${isAdmin ? `<button class="member-table-btn member-table-btn--edit" data-action="edit-row" data-device="${row.device}" data-entry-key="${row.entryKey}">Edit</button>
         <button class="member-table-btn member-table-btn--delete" data-action="delete-row" data-device="${row.device}" data-entry-key="${row.entryKey}">Hapus</button>` : ''}
        </td>`;

    return `
      <tr>
        ${checkboxCell}
        <td>${row.timestamp ? new Date(row.timestamp).toLocaleString('id-ID') : '-'}</td>
        <td><span class="member-device-badge">${getDisplayDeviceName(row.device) || '-'}</span></td>
        <td>${row.pm25}</td>
        <td>${row.pm10}</td>
        <td>${row.suhu}°C</td>
        <td>${row.kelembaban}%</td>
        <td>${windSpeed}</td>
        <td>${windDirection}</td>
        <td><span class="member-status-badge" style="color:${statusColor};border-color:${statusColor}40;background:${statusColor}10">AQI ${summary.finalAqi} · ${summary.category}</span></td>
        ${actionCell}
      </tr>
    `;
  }).join('');
}

function buildMemberTableQuery(filters = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(filters.limit || 500));
  if (filters.device) params.set('device', filters.device);
  if (filters.startDate) params.set('startDate', filters.startDate);
  if (filters.endDate) params.set('endDate', filters.endDate);
  return params.toString();
}

function getMemberTableFilters() {
  const device = document.getElementById('memberFilterDevice')?.value?.trim() || '';
  const startDate = document.getElementById('memberFilterStartDate')?.value || '';
  const endDate = document.getElementById('memberFilterEndDate')?.value || '';
  const limitRaw = document.getElementById('memberFilterLimit')?.value || '500';
  const limitNum = Number.parseInt(limitRaw, 10);
  const limit = Number.isFinite(limitNum) ? Math.min(Math.max(limitNum, 1), 5000) : 500;

  if (startDate && endDate && startDate > endDate) {
    throw new Error('Tanggal awal tidak boleh lebih besar dari tanggal akhir');
  }

  return { device, startDate, endDate, limit };
}

async function loadMemberDeviceFilterOptions(forceReload = false) {
  const deviceSelect = document.getElementById('memberFilterDevice');
  if (!deviceSelect) return;
  if (!forceReload && deviceSelect.dataset.loaded === '1') return;

  const previousValue = deviceSelect.value;
  const response = await apiFetch('/api/current');
  if (response.status === 401 || response.status === 403) return;
  if (!response.ok) throw new Error(`Load device filter failed: ${response.status}`);

  const payload = await response.json();
  const deviceIds = Object.keys(payload || {}).sort();

  deviceSelect.innerHTML = '<option value="">Semua Device</option>';
  deviceIds.forEach((deviceId) => {
    const option = document.createElement('option');
    option.value = deviceId;
    option.textContent = getDisplayDeviceName(deviceId);
    deviceSelect.appendChild(option);
  });

  if (previousValue && deviceIds.includes(previousValue)) {
    deviceSelect.value = previousValue;
  }

  deviceSelect.dataset.loaded = '1';
}

async function loadMemberTable(options = {}) {
  if (!(currentRole === 'admin' || currentRole === 'user')) return;

  setMemberDataMessage('Memuat data...');
  try {
    const shouldReloadDevices = options.refreshDevices === true;
    await loadMemberDeviceFilterOptions(shouldReloadDevices);

    const filters = getMemberTableFilters();
    const query = buildMemberTableQuery(filters);
    const response = await apiFetch(`/api/member/table?${query}`);
    if (response.status === 401 || response.status === 403) {
      setMemberDataMessage('Silakan login untuk melihat data tabel', true);
      return;
    }
    if (!response.ok) throw new Error(`Load member table failed: ${response.status}`);

    const payload = await response.json();
    renderMemberDataTable(payload.rows || []);
    setMemberDataMessage(`${payload.rows?.length || 0} data dimuat`);
  } catch (error) {
    console.error('Load member table error:', error);
    setMemberDataMessage(error.message || 'Gagal memuat data tabel', true);
  }
}

async function updateMemberDataRow(device, entryKey) {
  const pm25 = prompt('PM2.5 baru?');
  const pm10 = prompt('PM10 baru?');
  const suhu = prompt('Suhu baru (°C)?');
  const kelembaban = prompt('Kelembaban baru (%)?');
  const kecepatanAngin = prompt('Kecepatan angin baru (m/s)?');
  const arahAngin = prompt('Arah angin baru (°)?');
  
  if (pm25 === null || pm10 === null || suhu === null || kelembaban === null || kecepatanAngin === null || arahAngin === null) return;

  const body = {
    pm25: Number(pm25) || 0,
    pm10: Number(pm10) || 0,
    suhu: Number(suhu) || 0,
    kelembaban: Number(kelembaban) || 0,
    kecepatan_angin: Number(kecepatanAngin) || 0,
    arah_angin: Number(arahAngin) || 0,
    timestamp: new Date().toISOString()
  };

  const response = await apiFetch(`/api/admin/data/${device}/${entryKey}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Gagal update data');
  }
}

async function deleteMemberDataRow(device, entryKey) {
  if (!confirm('Hapus data ini?')) return;

  const response = await apiFetch(`/api/admin/data/${device}/${entryKey}`, { method: 'DELETE' });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Gagal hapus data');
  }
}

async function downloadCsvForDeviceDate(device, date) {
  const response = await apiFetch(`/api/download/${device}/${date}`);
  if (response.status === 401 || response.status === 403) { handleUnauthorizedResponse(); return; }
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);

  const blob = await response.blob();
  const blobUrl = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = `${device}_${date}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(blobUrl);
}

async function downloadFilteredMemberCsv() {
  if (!(currentRole === 'admin' || currentRole === 'user')) return;

  const filters = getMemberTableFilters();
  const query = buildMemberTableQuery(filters);
  const response = await apiFetch(`/api/member/table/download?${query}`);

  if (response.status === 401 || response.status === 403) { handleUnauthorizedResponse(); return; }
  if (!response.ok) throw new Error(`Download filtered CSV failed: ${response.status}`);

  const blob = await response.blob();
  const blobUrl = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  const fallbackName = `member_data_${new Date().toISOString().slice(0, 10)}.csv`;
  const contentDisposition = response.headers.get('content-disposition') || '';
  const filenameMatch = /filename="?([^";]+)"?/i.exec(contentDisposition);

  link.href = blobUrl;
  link.download = filenameMatch?.[1] || fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(blobUrl);
}

// ---- LOCATIONS ----

function initLocationMapIfNeeded() {
  if (!window.L || locationMap) return;

  locationMap = L.map('locationMap').setView([ACTIVE_LOCATION_LAT, ACTIVE_LOCATION_LNG], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(locationMap);

  locationMarkersLayer = L.layerGroup().addTo(locationMap);
}

function renderLocationList(locations = []) {
  const list = document.getElementById('locationList');
  if (!list) return;

  const isAdmin = currentRole === 'admin';

  if (!locations.length) {
    list.innerHTML = '<div class="admin-empty">Belum ada lokasi</div>';
    return;
  }

  list.innerHTML = locations.map((loc) => {
    if (!isAdmin) {
      return `
        <div class="location-item">
          <div class="location-item-title">${loc.name || ACTIVE_LOCATION_NAME}</div>
          <div>Device: ${getDisplayDeviceName(loc.device)}</div>
          <div>Lat: ${loc.lat}</div>
          <div>Lng: ${loc.lng}</div>
        </div>
      `;
    }
    return `
      <div class="location-item" data-device="${loc.device}">
        <div class="location-item-title">${loc.name || ACTIVE_LOCATION_NAME}</div>
        <input type="text" data-field="name" value="${loc.name || ACTIVE_LOCATION_NAME}" placeholder="Nama lokasi" />
        <input type="number" step="any" data-field="lat" value="${loc.lat}" placeholder="Latitude" />
        <input type="number" step="any" data-field="lng" value="${loc.lng}" placeholder="Longitude" />
        <button class="location-bar-button" data-action="save-location">Simpan Koordinat</button>
      </div>
    `;
  }).join('');
}

function renderLocationMarkers(locations = []) {
  initLocationMapIfNeeded();
  if (!locationMap || !locationMarkersLayer) return;

  locationMarkersLayer.clearLayers();
  if (!locations.length) return;

  const bounds = [];
  locations.forEach((loc) => {
    const lat = Number(loc.lat);
    const lng = Number(loc.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    const marker = L.marker([lat, lng]).bindPopup(`<b>${loc.name || ACTIVE_LOCATION_NAME}</b><br/>${getDisplayDeviceName(loc.device)}`);
    marker.addTo(locationMarkersLayer);
    bounds.push([lat, lng]);
  });

  if (bounds.length) locationMap.fitBounds(bounds, { padding: [20, 20], maxZoom: 13 });
}

async function loadMemberLocations() {
  if (!(currentRole === 'admin' || currentRole === 'user')) return;

  setLocationMessage('Memuat lokasi...');
  try {
    const response = await apiFetch('/api/member/locations');
    if (response.status === 401 || response.status === 403) {
      setLocationMessage('Silakan login untuk melihat lokasi', true);
      return;
    }
    if (!response.ok) throw new Error(`Load locations failed: ${response.status}`);

    const payload = await response.json();
    renderLocationList(payload.locations || []);
    renderLocationMarkers(payload.locations || []);
    setLocationMessage(`${payload.locations?.length || 0} lokasi dimuat`);
  } catch (error) {
    console.error('Load locations error:', error);
    setLocationMessage('Gagal memuat lokasi', true);
  }
}

async function saveLocationRow(locationCardElement) {
  const device = locationCardElement.getAttribute('data-device');
  const name = locationCardElement.querySelector('[data-field="name"]')?.value?.trim() || device;
  const lat = Number(locationCardElement.querySelector('[data-field="lat"]')?.value);
  const lng = Number(locationCardElement.querySelector('[data-field="lng"]')?.value);

  const response = await apiFetch(`/api/admin/locations/${device}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, lat, lng })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Gagal simpan koordinat');
  }
}

function initMemberHandlers() {
  const btnReloadMemberTable = document.getElementById('btnReloadMemberTable');
  const btnApplyMemberFilter = document.getElementById('btnApplyMemberFilter');
  const btnResetMemberFilter = document.getElementById('btnResetMemberFilter');
  const btnDownloadFilteredMember = document.getElementById('btnDownloadFilteredMember');
  const btnReloadLocations = document.getElementById('btnReloadLocations');
  const memberDataTableBody = document.getElementById('memberDataTableBody');
  const locationList = document.getElementById('locationList');
  const memberFilterDevice = document.getElementById('memberFilterDevice');
  const memberFilterStartDate = document.getElementById('memberFilterStartDate');
  const memberFilterEndDate = document.getElementById('memberFilterEndDate');
  const memberFilterLimit = document.getElementById('memberFilterLimit');
  const btnToggleSelect = document.getElementById('btnToggleSelect');
  const selectAllCheckbox = document.getElementById('selectAllCheckbox');
  const btnEditSelected = document.getElementById('btnEditSelected');
  const btnDeleteSelected = document.getElementById('btnDeleteSelected');

  if (btnReloadMemberTable) btnReloadMemberTable.onclick = async () => { await loadMemberTable({ refreshDevices: true }); };
  if (btnApplyMemberFilter) btnApplyMemberFilter.onclick = async () => { await loadMemberTable(); };
  if (btnDownloadFilteredMember) {
    btnDownloadFilteredMember.onclick = async () => {
      try {
        await downloadFilteredMemberCsv();
      } catch (error) {
        setMemberDataMessage(error.message || 'Gagal mengunduh CSV filter', true);
      }
    };
  }
  if (btnResetMemberFilter) {
    btnResetMemberFilter.onclick = async () => {
      if (memberFilterDevice) memberFilterDevice.value = '';
      if (memberFilterStartDate) memberFilterStartDate.value = '';
      if (memberFilterEndDate) memberFilterEndDate.value = '';
      if (memberFilterLimit) memberFilterLimit.value = '500';
      await loadMemberTable();
    };
  }

  if (memberFilterDevice) memberFilterDevice.onchange = async () => { await loadMemberTable(); };
  if (memberFilterLimit) memberFilterLimit.onchange = async () => { await loadMemberTable(); };
  if (btnReloadLocations) btnReloadLocations.onclick = async () => { await loadMemberLocations(); };

  // Select mode toggle
  if (btnToggleSelect) {
    btnToggleSelect.onclick = () => {
      const checkboxColumn = document.querySelector('.checkbox-column');
      const memberTableActions = document.getElementById('memberTableActions');
      const isSelectMode = checkboxColumn.style.display !== 'none';
      
      if (isSelectMode) {
        // Exit select mode
        checkboxColumn.style.display = 'none';
        memberTableActions.style.display = 'none';
        btnToggleSelect.textContent = 'Select';
        selectAllCheckbox.checked = false;
      } else {
        // Enter select mode
        checkboxColumn.style.display = 'table-cell';
        memberTableActions.style.display = 'flex';
        btnToggleSelect.textContent = 'Cancel';
      }
      
      // Refresh table to update layout
      loadMemberTable();
    };
  }

  // Select all functionality
  if (selectAllCheckbox) {
    selectAllCheckbox.onchange = () => {
      const rowCheckboxes = document.querySelectorAll('.row-checkbox');
      rowCheckboxes.forEach(checkbox => {
        checkbox.checked = selectAllCheckbox.checked;
      });
      updateBulkActionButtons();
    };
  }

  // Bulk edit functionality
  if (btnEditSelected) {
    btnEditSelected.onclick = async () => {
      const selectedRows = getSelectedRows();
      if (selectedRows.length === 0) {
        setMemberDataMessage('Pilih minimal 1 data untuk diedit', true);
        return;
      }
      
      if (selectedRows.length > 1) {
        setMemberDataMessage('Edit hanya bisa untuk 1 data saja', true);
        return;
      }
      
      const { device, entryKey } = selectedRows[0];
      try {
        await updateMemberDataRow(device, entryKey);
        await loadMemberTable();
        setMemberDataMessage('Data berhasil diedit');
      } catch (error) {
        setMemberDataMessage(error.message, true);
      }
    };
  }

  // Bulk delete functionality
  if (btnDeleteSelected) {
    btnDeleteSelected.onclick = async () => {
      const selectedRows = getSelectedRows();
      if (selectedRows.length === 0) {
        setMemberDataMessage('Pilih minimal 1 data untuk dihapus', true);
        return;
      }
      
      if (!confirm(`Hapus ${selectedRows.length} data yang dipilih?`)) return;
      
      try {
        for (const { device, entryKey } of selectedRows) {
          await deleteMemberDataRow(device, entryKey);
        }
        await loadMemberTable();
        setMemberDataMessage(`${selectedRows.length} data berhasil dihapus`);
      } catch (error) {
        setMemberDataMessage(error.message, true);
      }
    };
  }

  if (memberDataTableBody) {
    memberDataTableBody.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      
      // Handle row checkbox changes
      if (target.classList.contains('row-checkbox')) {
        updateBulkActionButtons();
        updateSelectAllCheckbox();
        return;
      }
      
      const action = target.dataset.action;
      if (!action) return;

      const device = target.dataset.device;
      const date = target.dataset.date;
      const entryKey = target.dataset.entryKey;

      try {
        if (action === 'download-row' && device && date) { await downloadCsvForDeviceDate(device, date); return; }
        if (currentRole !== 'admin') return;
        if (action === 'edit-row' && device && entryKey) { await updateMemberDataRow(device, entryKey); await loadMemberTable(); return; }
        if (action === 'delete-row' && device && entryKey) { await deleteMemberDataRow(device, entryKey); await loadMemberTable(); }
      } catch (error) { setMemberDataMessage(error.message, true); }
    });
  }

  if (locationList) {
    locationList.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.dataset.action !== 'save-location') return;
      if (currentRole !== 'admin') return;
      const row = target.closest('.location-item');
      if (!row) return;
      try {
        await saveLocationRow(row);
        setLocationMessage('Koordinat berhasil disimpan');
        await loadMemberLocations();
      } catch (error) { setLocationMessage(error.message, true); }
    });
  }
}

function getSelectedRows() {
  const selectedCheckboxes = document.querySelectorAll('.row-checkbox:checked');
  return Array.from(selectedCheckboxes).map(checkbox => ({
    device: checkbox.dataset.device,
    entryKey: checkbox.dataset.entryKey
  }));
}

function updateBulkActionButtons() {
  const selectedCount = document.querySelectorAll('.row-checkbox:checked').length;
  const btnEditSelected = document.getElementById('btnEditSelected');
  const btnDeleteSelected = document.getElementById('btnDeleteSelected');
  
  if (btnEditSelected) {
    btnEditSelected.disabled = selectedCount !== 1;
    btnEditSelected.style.opacity = selectedCount === 1 ? '1' : '0.5';
  }
  
  if (btnDeleteSelected) {
    btnDeleteSelected.disabled = selectedCount === 0;
    btnDeleteSelected.style.opacity = selectedCount > 0 ? '1' : '0.5';
  }
}

function updateSelectAllCheckbox() {
  const selectAllCheckbox = document.getElementById('selectAllCheckbox');
  const rowCheckboxes = document.querySelectorAll('.row-checkbox');
  
  if (rowCheckboxes.length === 0) {
    selectAllCheckbox.checked = false;
    return;
  }
  
  const checkedCount = document.querySelectorAll('.row-checkbox:checked').length;
  selectAllCheckbox.checked = checkedCount === rowCheckboxes.length;
}

// ---- AIR QUALITY ALERTS ----

function getAlertToneClass(aqi) {
  if (aqi >= 201) return 'extreme';
  if (aqi >= 151) return 'danger';
  return 'warn';
}

function hideAirAlert() {
  const bar = document.getElementById('airAlertBar');
  if (!bar) return;
  bar.style.display = 'none';
  bar.classList.remove('warn', 'danger', 'extreme');
  currentAlertSignature = null;
}

function showAirAlert(message, toneClass, signature) {
  const bar = document.getElementById('airAlertBar');
  const text = document.getElementById('airAlertText');
  if (!bar || !text) return;
  bar.classList.remove('warn', 'danger', 'extreme');
  bar.classList.add(toneClass);
  text.textContent = message;
  bar.style.display = 'flex';
  currentAlertSignature = signature;
}

function dismissAirAlert() {
  dismissedAlertSignature = currentAlertSignature;
  hideAirAlert();
}

function sendBrowserAlertIfAllowed(signature, title, message) {
  if (lastBrowserNotificationSignature === signature) return;
  if (!('Notification' in window)) return;

  const showNotification = () => {
    try { new Notification(title, { body: message }); lastBrowserNotificationSignature = signature; }
    catch (error) { console.warn('Browser notification error:', error); }
  };

  if (Notification.permission === 'granted') { showNotification(); return; }
  if (Notification.permission === 'default') {
    Notification.requestPermission().then((perm) => { if (perm === 'granted') showNotification(); }).catch(() => {});
  }
}

async function sendTelegramAlertIfAllowed(signature, title, message) {
  if (lastTelegramAlertSignature === signature) return;
  if (!authToken) return;

  try {
    const response = await apiFetch('/api/alerts/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, message })
    });

    if (response.ok) {
      lastTelegramAlertSignature = signature;
      return;
    }

    // 503 means Telegram env is not configured; skip quietly
    if (response.status === 503) return;

    const payload = await response.json().catch(() => ({}));
    console.warn('Telegram alert skipped:', payload.error || response.status);
  } catch (error) {
    console.warn('Telegram alert error:', error?.message || error);
  }
}

function processAirQualityAlert(deviceId, aqi, category, timestamp, pm25, pm10) {
  if (!deviceId) return;

  const state = alertStateByDevice[deviceId] || { lastAqi: 0, lastAlertAt: 0, lastSignature: null };

  if (aqi < UNHEALTHY_AQI_THRESHOLD) {
    alertStateByDevice[deviceId] = { ...state, lastAqi: 0 };
    dismissedAlertSignature = null;
    hideAirAlert();
    return;
  }

  const signature = `${deviceId}|${timestamp}|${aqi}|${category}`;
  const toneClass = getAlertToneClass(aqi);
  const displayDevice = getDisplayDeviceName(deviceId);
  const message = `⚠ ${displayDevice}: AQI ${aqi} (${category}) · PM2.5 ${pm25} · PM10 ${pm10}`;
  const now = Date.now();
  const isEscalated = aqi > state.lastAqi;
  const isNewSignature = signature !== state.lastSignature;
  const cooldownPassed = (now - state.lastAlertAt) >= ALERT_COOLDOWN_MS;

  if (dismissedAlertSignature !== signature) showAirAlert(message, toneClass, signature);

  if (isNewSignature && (isEscalated || cooldownPassed)) {
    sendBrowserAlertIfAllowed(signature, `Peringatan Udara · ${displayDevice}`, message);
    sendTelegramAlertIfAllowed(signature, `Peringatan Udara · ${displayDevice}`, message);
    alertStateByDevice[deviceId] = { lastAqi: aqi, lastAlertAt: now, lastSignature: signature };
    return;
  }

  alertStateByDevice[deviceId] = { ...state, lastAqi: Math.max(state.lastAqi || 0, aqi), lastSignature: signature };
}

// ======================================================
// CHART SECTION - MULTI-METRIC GRAPHS
// ======================================================

const chartInstances = {};

function setChartMessage(message, isError = false) {
  const el = document.getElementById('chartMessage');
  if (!el) return;
  el.textContent = message;
  el.style.color = isError ? '#ef4444' : '#64748b';
}

function destroyChart(canvasId) {
  if (chartInstances[canvasId]) {
    chartInstances[canvasId].destroy();
    delete chartInstances[canvasId];
  }
}

function getChartColors() {
  return {
    pm25: { border: '#f97316', background: 'rgba(249, 115, 22, 0.1)' },
    pm10: { border: '#eab308', background: 'rgba(234, 179, 8, 0.1)' },
    suhu: { border: '#22c55e', background: 'rgba(34, 197, 94, 0.1)' },
    kelembaban: { border: '#3b82f6', background: 'rgba(59, 130, 246, 0.1)' },
    kecepatan_angin: { border: '#06b6d4', background: 'rgba(6, 182, 212, 0.1)' },
    arah_angin: { border: '#a855f7', background: 'rgba(168, 85, 247, 0.1)' }
  };
}

function createMetricChart(canvasId, label, data, timestamps, colorConfig) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId)?.getContext('2d');
  if (!ctx) return null;

  // Calculate average line
  const validData = data.filter(v => v !== null && v !== undefined);
  const average = validData.length > 0 ? validData.reduce((sum, val) => sum + val, 0) / validData.length : 0;
  const averageLine = data.map(() => average);

  const chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: timestamps,
      datasets: [
        {
          label: label,
          data: data,
          borderColor: colorConfig.border,
          backgroundColor: colorConfig.background,
          borderWidth: 2,
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          pointHoverRadius: 4
        },
        {
          label: 'Rata-rata',
          data: averageLine,
          borderColor: '#ef4444',
          backgroundColor: 'transparent',
          borderWidth: 2,
          borderDash: [5, 5],
          fill: false,
          tension: 0,
          pointRadius: 0,
          pointHoverRadius: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      animation: { duration: 400 },
      plugins: {
        legend: {
          display: true,
          labels: {
            color: '#64748b',
            font: { family: 'JetBrains Mono', size: 10 },
            boxWidth: 12
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
          callbacks: {
            label: function(context) {
              if (context.datasetIndex === 1) {
                return `Rata-rata: ${average.toFixed(2)}`;
              }
              return `${context.dataset.label}: ${context.parsed.y?.toFixed(2) || 'N/A'}`;
            }
          }
        }
      },
      scales: {
        x: {
          ticks: {
            color: '#64748b',
            font: { family: 'JetBrains Mono', size: 9 },
            maxTicksLimit: 12,
            maxRotation: 45,
            minRotation: 0,
            autoSkip: true,
            callback: function(value, index, values) {
              // For mobile, show fewer labels
              if (window.innerWidth < 768 && values.length > 8) {
                return index % Math.ceil(values.length / 6) === 0 ? this.getLabelForValue(value) : '';
              }
              return this.getLabelForValue(value);
            }
          },
          grid: { color: 'rgba(26,45,68,0.8)' }
        },
        y: {
          ticks: {
            color: '#64748b',
            font: { family: 'JetBrains Mono', size: 9 }
          },
          grid: { color: 'rgba(26,45,68,0.8)' }
        }
      }
    }
  });

  chartInstances[canvasId] = chart;
  return chart;
}

function renderMetricCharts(rows) {
  if (!rows || rows.length === 0) {
    setChartMessage('Tidak ada data untuk ditampilkan', true);
    return;
  }

  const colors = getChartColors();
  
  // Sort by timestamp
  const sortedRows = [...rows].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  
  // Format timestamps with date and time for better display
  const timestamps = sortedRows.map(row => {
    const date = new Date(row.timestamp);
    const dateStr = date.toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit' });
    const timeStr = date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    return `${dateStr} ${timeStr}`;
  });

  // Extract data for each metric
  const pm25Data = sortedRows.map(row => row.pm25 ?? null);
  const pm10Data = sortedRows.map(row => row.pm10 ?? null);
  const suhuData = sortedRows.map(row => row.suhu ?? null);
  const kelembabanData = sortedRows.map(row => row.kelembaban ?? null);
  const kecepatanAnginData = sortedRows.map(row => row.kecepatan_angin ?? null);
  const arahAnginData = sortedRows.map(row => row.arah_angin ?? null);

  // Create charts for metrics with data
  if (pm25Data.some(v => v !== null)) {
    createMetricChart('pm25Chart', 'PM2.5 (µg/m³)', pm25Data, timestamps, colors.pm25);
  }
  if (pm10Data.some(v => v !== null)) {
    createMetricChart('pm10Chart', 'PM10 (µg/m³)', pm10Data, timestamps, colors.pm10);
  }
  if (suhuData.some(v => v !== null)) {
    createMetricChart('suhuChart', 'Suhu (°C)', suhuData, timestamps, colors.suhu);
  }
  if (kelembabanData.some(v => v !== null)) {
    createMetricChart('kelembabanChart', 'Kelembaban (%)', kelembabanData, timestamps, colors.kelembaban);
  }
  if (kecepatanAnginData.some(v => v !== null)) {
    createMetricChart('kecepatanAnginChart', 'Kecepatan Angin (m/s)', kecepatanAnginData, timestamps, colors.kecepatan_angin);
  }
  if (arahAnginData.some(v => v !== null)) {
    createMetricChart('arahAnginChart', 'Arah Angin (°)', arahAnginData, timestamps, colors.arah_angin);
  }

  setChartMessage(`${rows.length} data points loaded`);
}

async function loadChartDeviceOptions() {
  const deviceSelect = document.getElementById('chartFilterDevice');
  if (!deviceSelect) return;

  try {
    const response = await apiFetch('/api/current');
    if (!response.ok) return;

    const payload = await response.json();
    const deviceIds = Object.keys(payload || {}).sort();

    deviceSelect.innerHTML = '<option value="">Pilih Device</option>';
    deviceIds.forEach((deviceId) => {
      const option = document.createElement('option');
      option.value = deviceId;
      option.textContent = getDisplayDeviceName(deviceId);
      deviceSelect.appendChild(option);
    });
  } catch (error) {
    console.error('Load chart devices error:', error);
  }
}

async function loadChartData() {
  const device = document.getElementById('chartFilterDevice')?.value;
  const startDate = document.getElementById('chartFilterStartDate')?.value;
  const endDate = document.getElementById('chartFilterEndDate')?.value;

  if (!device) {
    setChartMessage('Pilih device terlebih dahulu', true);
    return;
  }

  setChartMessage('Memuat data grafik...');

  try {
    const params = new URLSearchParams();
    params.set('device', device);
    params.set('limit', '5000');
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);

    const response = await apiFetch(`/api/member/table?${params.toString()}`);
    if (!response.ok) throw new Error(`Load failed: ${response.status}`);

    const payload = await response.json();
    renderMetricCharts(payload.rows || []);
  } catch (error) {
    console.error('Load chart data error:', error);
    setChartMessage('Gagal memuat data: ' + error.message, true);
  }
}

function initChartHandlers() {
  const btnApplyChartFilter = document.getElementById('btnApplyChartFilter');
  const btnResetChartFilter = document.getElementById('btnResetChartFilter');
  const btnReloadChart = document.getElementById('btnReloadChart');
  const chartFilterDevice = document.getElementById('chartFilterDevice');
  const chartFilterStartDate = document.getElementById('chartFilterStartDate');
  const chartFilterEndDate = document.getElementById('chartFilterEndDate');

  if (btnApplyChartFilter) {
    btnApplyChartFilter.onclick = loadChartData;
  }

  if (btnResetChartFilter) {
    btnResetChartFilter.onclick = () => {
      if (chartFilterDevice) chartFilterDevice.value = '';
      if (chartFilterStartDate) chartFilterStartDate.value = '';
      if (chartFilterEndDate) chartFilterEndDate.value = '';
      // Clear all charts
      Object.keys(chartInstances).forEach(id => destroyChart(id));
      setChartMessage('Filter direset');
    };
  }

  if (btnReloadChart) {
    btnReloadChart.onclick = () => {
      loadChartDeviceOptions();
      loadChartData();
    };
  }

  if (chartFilterDevice) {
    chartFilterDevice.onchange = loadChartData;
  }

  // Chart download buttons
  document.querySelectorAll('.chart-download-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const canvasId = btn.dataset.chart;
      const metric = btn.dataset.metric;
      const canvas = document.getElementById(canvasId);
      if (!canvas) return;

      const link = document.createElement('a');
      link.download = `${metric}_chart_${new Date().toISOString().slice(0,10)}.png`;
      link.href = canvas.toDataURL('image/png');
      document.body.appendChild(link);
      link.click();
      link.remove();
    });
  });
}

// Initialize chart functionality when section is shown
document.addEventListener('DOMContentLoaded', () => {
  // Chart section navigation handler
  const chartNavBtn = document.querySelector('[data-section="chart"]');
  if (chartNavBtn) {
    chartNavBtn.addEventListener('click', () => {
      loadChartDeviceOptions();
    });
  }
  
  initChartHandlers();
});
