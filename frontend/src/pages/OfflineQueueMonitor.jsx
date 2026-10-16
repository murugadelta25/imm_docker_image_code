import React, { useEffect, useState, useCallback } from 'react';
import { useTheme } from '../context/ThemeContext';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const OfflineQueueMonitor = () => {
  const t = useTheme();
  const [queueStatus, setQueueStatus] = useState(null);
  const [pendingEntries, setPendingEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState(5); // seconds

  const fetchQueueStatus = useCallback(async () => {
    try {
      const res = await api.get('/api/imm/nodered/queue/status');
      setQueueStatus(res.data);
    } catch (err) {
      console.error('Failed to fetch queue status:', err.message);
    }
  }, []);

  const fetchPendingEntries = useCallback(async () => {
    try {
      const res = await api.get('/api/imm/nodered/queue/pending', {
        params: { limit: 50, max_age_minutes: 15 },
      });
      setPendingEntries(res.data?.entries || []);
    } catch (err) {
      console.error('Failed to fetch pending entries:', err.message);
    }
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    await Promise.all([fetchQueueStatus(), fetchPendingEntries()]);
    setLoading(false);
  }, [fetchQueueStatus, fetchPendingEntries]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Auto-refresh loop
  useEffect(() => {
    if (!autoRefresh) return undefined;

    const interval = setInterval(fetchData, refreshInterval * 1000);
    return () => clearInterval(interval);
  }, [autoRefresh, refreshInterval, fetchData]);

  // Listen for offline data restoration events
  useEffect(() => {
    const handleOfflineDataRestored = (event) => {
      console.log('[OfflineQueueMonitor] Offline data restored event:', event.detail);
      fetchData();
    };

    window.addEventListener('offline-data-restored', handleOfflineDataRestored);
    return () => window.removeEventListener('offline-data-restored', handleOfflineDataRestored);
  }, [fetchData]);

  const handleCleanupQueue = async () => {
    if (!window.confirm('Are you sure you want to clean up old offline queue entries (older than 7 days)?')) {
      return;
    }

    try {
      const res = await api.post('/api/imm/nodered/queue/cleanup', {}, { params: { days_old: 7 } });
      if (res.data?.ok) {
        alert(`Cleaned up ${res.data?.removed || 0} entries`);
        fetchData();
      }
    } catch (err) {
      alert('Cleanup failed: ' + err.message);
    }
  };

  const styles = {
    container: {
      padding: '20px',
      backgroundColor: t.surface,
      color: t.text,
    },
    card: {
      backgroundColor: t.surface,
      border: `1px solid ${t.border}`,
      borderRadius: '8px',
      padding: '16px',
      marginBottom: '16px',
    },
    header: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
      gap: '16px',
      marginBottom: '20px',
    },
    statCard: {
      backgroundColor: t.surfaceHover,
      padding: '16px',
      borderRadius: '8px',
      border: `1px solid ${t.border}`,
      textAlign: 'center',
    },
    statValue: {
      fontSize: '28px',
      fontWeight: 'bold',
      color: '#10b981',
      marginBottom: '8px',
    },
    statLabel: {
      fontSize: '14px',
      color: t.textDim,
    },
    statusOnline: {
      color: '#10b981',
      fontWeight: 'bold',
    },
    statusOffline: {
      color: '#ef4444',
      fontWeight: 'bold',
    },
    table: {
      width: '100%',
      borderCollapse: 'collapse',
      marginTop: '12px',
    },
    th: {
      textAlign: 'left',
      padding: '12px',
      borderBottom: `1px solid ${t.border}`,
      backgroundColor: t.surfaceHover,
      fontSize: '13px',
      fontWeight: '600',
      color: t.textDim,
    },
    td: {
      padding: '12px',
      borderBottom: `1px solid ${t.border}`,
      fontSize: '13px',
    },
    controls: {
      display: 'flex',
      gap: '12px',
      marginBottom: '16px',
      alignItems: 'center',
      flexWrap: 'wrap',
    },
    button: {
      padding: '8px 16px',
      border: 'none',
      borderRadius: '4px',
      cursor: 'pointer',
      fontSize: '13px',
      fontWeight: '500',
    },
    buttonPrimary: {
      backgroundColor: '#3b82f6',
      color: 'white',
    },
    buttonSecondary: {
      backgroundColor: t.surfaceHover,
      color: t.text,
      border: `1px solid ${t.border}`,
    },
    buttonDanger: {
      backgroundColor: '#ef4444',
      color: 'white',
    },
    noData: {
      padding: '32px',
      textAlign: 'center',
      color: t.textDim,
    },
    label: {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      fontSize: '13px',
    },
    input: {
      padding: '6px 8px',
      borderRadius: '4px',
      border: `1px solid ${t.border}`,
      backgroundColor: t.surface,
      color: t.text,
      fontSize: '13px',
    },
  };

  if (loading && !queueStatus) {
    return (
      <div style={styles.container}>
        <PageHeader title="Offline Queue Monitor" subtitle="Monitoring Node-RED offline data queue" />
        <div style={styles.noData}>Loading queue status...</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <PageHeader 
        title="Offline Queue Monitor" 
        subtitle="Real-time monitoring of Node-RED offline data queuing and restoration" 
      />

      {/* Status Cards */}
      <div style={styles.header}>
        <div style={styles.statCard}>
          <div style={styles.statValue}>
            {queueStatus?.is_online ? '🟢' : '🔴'}
          </div>
          <div style={styles.statLabel}>Connection Status</div>
          <div style={queueStatus?.is_online ? styles.statusOnline : styles.statusOffline}>
            {queueStatus?.is_online ? 'ONLINE' : 'OFFLINE'}
          </div>
        </div>

        <div style={styles.statCard}>
          <div style={styles.statValue}>{queueStatus?.queue_size || 0}</div>
          <div style={styles.statLabel}>Queued Entries</div>
          <div style={{ fontSize: '12px', color: t.textDim }}>
            Awaiting restoration
          </div>
        </div>

        <div style={styles.statCard}>
          <div style={styles.statValue}>{queueStatus?.total_offline_devices || 0}</div>
          <div style={styles.statLabel}>Offline Devices</div>
          <div style={{ fontSize: '12px', color: t.textDim }}>
            Not responding
          </div>
        </div>

        <div style={styles.statCard}>
          <div style={styles.statValue}>{queueStatus?.last_restore_count || 0}</div>
          <div style={styles.statLabel}>Last Restored</div>
          <div style={{ fontSize: '12px', color: t.textDim }}>
            Entries processed
          </div>
        </div>
      </div>

      {/* Controls */}
      <div style={styles.card}>
        <div style={styles.controls}>
          <label style={styles.label}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Auto-Refresh
          </label>
          {autoRefresh && (
            <label style={styles.label}>
              Interval:
              <input
                type="number"
                min="1"
                max="60"
                value={refreshInterval}
                onChange={(e) => setRefreshInterval(Math.max(1, parseInt(e.target.value) || 5))}
                style={styles.input}
              />
              sec
            </label>
          )}
          <button
            style={{ ...styles.button, ...styles.buttonPrimary }}
            onClick={fetchData}
          >
            🔄 Refresh Now
          </button>
          <button
            style={{ ...styles.button, ...styles.buttonDanger }}
            onClick={handleCleanupQueue}
          >
            🗑️ Cleanup Old Entries
          </button>
        </div>
      </div>

      {/* Offline Since */}
      {queueStatus?.offline_since && (
        <div style={styles.card}>
          <div style={{ color: '#ef4444', fontWeight: 'bold' }}>
            ⚠️ Offline Since {new Date(queueStatus.offline_since).toLocaleString()}
          </div>
          <div style={{ fontSize: '12px', color: t.textDim, marginTop: '8px' }}>
            Data is being queued locally until connection is restored
          </div>
        </div>
      )}

      {/* Offline Devices */}
      {queueStatus?.total_offline_devices > 0 && (
        <div style={styles.card}>
          <div style={{ fontWeight: 'bold', marginBottom: '12px' }}>
            📊 Offline Devices ({queueStatus.total_offline_devices})
          </div>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Device/Machine</th>
                <th style={styles.th}>Offline Since</th>
                <th style={styles.th}>Queued Entries</th>
              </tr>
            </thead>
            <tbody>
              {queueStatus.offline_devices?.map((device, idx) => (
                <tr key={idx}>
                  <td style={styles.td}>
                    <strong>{device.machine_name || device.device_id}</strong>
                  </td>
                  <td style={styles.td}>
                    {device.offline_since
                      ? new Date(device.offline_since).toLocaleString()
                      : 'Unknown'}
                  </td>
                  <td style={styles.td}>
                    <span
                      style={{
                        backgroundColor: '#fbbf24',
                        color: '#000',
                        padding: '4px 8px',
                        borderRadius: '4px',
                        fontWeight: 'bold',
                      }}
                    >
                      {device.queued_entries || 0}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pending Queue Entries */}
      {pendingEntries.length > 0 && (
        <div style={styles.card}>
          <div style={{ fontWeight: 'bold', marginBottom: '12px' }}>
            📋 Pending Entries ({pendingEntries.length})
          </div>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Machine</th>
                <th style={styles.th}>Queued At</th>
                <th style={styles.th}>Parameters</th>
                <th style={styles.th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {pendingEntries.map((entry, idx) => (
                <tr key={idx}>
                  <td style={styles.td}>
                    <strong>{entry.machine_name || entry.device_id}</strong>
                  </td>
                  <td style={styles.td}>
                    {new Date(entry.queued_at).toLocaleString()}
                  </td>
                  <td style={styles.td}>{entry.params_count} parameters</td>
                  <td style={styles.td}>
                    <span
                      style={{
                        backgroundColor: '#fbbf24',
                        color: '#000',
                        padding: '4px 8px',
                        borderRadius: '4px',
                        fontSize: '11px',
                        fontWeight: 'bold',
                      }}
                    >
                      PENDING
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: '12px', color: t.textDim, marginTop: '12px' }}>
            ℹ️ These entries will be restored when connection is re-established, or in the next 15-minute batch
          </div>
        </div>
      )}

      {/* Empty State */}
      {queueStatus?.queue_size === 0 && queueStatus?.total_offline_devices === 0 && (
        <div style={styles.card}>
          <div style={styles.noData}>
            ✅ No offline data in queue. All systems online!
          </div>
        </div>
      )}

      {/* Info Section */}
      <div style={styles.card}>
        <div style={{ fontWeight: 'bold', marginBottom: '12px', color: t.textDim }}>
          ℹ️ How It Works
        </div>
        <ul style={{ lineHeight: '1.8', fontSize: '13px', color: t.textDim }}>
          <li>
            <strong>Health Checks:</strong> Every 10 seconds, Node-RED verifies connection to the webapp
          </li>
          <li>
            <strong>Offline Logging:</strong> When unreachable, IMM data is queued locally in Node-RED (not stored in database)
          </li>
          <li>
            <strong>Batch Restoration:</strong> Every 15 minutes or when connection is restored, queued data is sent as a batch
          </li>
          <li>
            <strong>No Blocking:</strong> Offline data queue never blocks WebSocket or freezes the webapp
          </li>
          <li>
            <strong>Auto-Cleanup:</strong> Successfully processed entries older than 7 days are automatically removed
          </li>
        </ul>
      </div>
    </div>
  );
};

export default OfflineQueueMonitor;
