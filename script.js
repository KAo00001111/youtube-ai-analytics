
/* =========================================
   YOUTUBE AI ANALYTICS STUDIO
   CSV + Charts + PDF + Chatbot + IndexedDB
========================================= */

const state = {
  data: [],
  columns: [],
  filtered: [],
  charts: {},
  page: 1,
  pageSize: 15,
  datasetId: null,
  datasetName: "",
  datasets: []
};

const METRICS = ["views", "likes", "dislikes", "comment_count"];

const LABELS = {
  views: "Views",
  likes: "Likes",
  dislikes: "Dislikes",
  comment_count: "Comments"
};

const DAY_ORDER = [
  "Monday", "Tuesday", "Wednesday", "Thursday",
  "Friday", "Saturday", "Sunday"
];

const DB_NAME = "YouTubeAnalyticsDB";
const DB_VERSION = 1;
let db;

/* ---------- HELPERS ---------- */

const $ = id => document.getElementById(id);

function number(value) {
  if (value === null || value === undefined || value === "") return 0;
  const result = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(result) ? result : 0;
}

function formatNumber(value) {
  return new Intl.NumberFormat("th-TH", {
    maximumFractionDigits: 2
  }).format(number(value));
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function notify(message) {
  const toast = $("toast");
  if (!toast) return;

  toast.textContent = message;
  toast.classList.add("show");

  clearTimeout(notify.timer);

  notify.timer = setTimeout(() => {
    toast.classList.remove("show");
  }, 3000);
}

function destroyChart(id) {
  if (state.charts[id]) {
    state.charts[id].destroy();
    delete state.charts[id];
  }
}

function getMonth(row) {
  const date = new Date(row.publish_date);

  if (Number.isNaN(date.getTime())) return "ไม่ระบุ";

  return date.toLocaleDateString("en-US", {
    month: "short",
    year: "numeric"
  });
}

/* ---------- COLUMN NORMALIZATION ---------- */

const COLUMN_ALIASES = {
  video_id: ["video_id", "videoid", "id"],
  title: ["title", "video_title", "name"],
  channel_title: ["channel_title", "channel", "channel_name"],
  publish_country: ["publish_country", "country", "country_code"],
  publish_date: ["publish_date", "published_at", "date"],
  published_day_of_week: [
    "published_day_of_week",
    "day_of_week",
    "weekday"
  ],
  time_frame: ["time_frame", "timeframe", "time"],
  category_id: ["category_id", "category", "category_name"],
  views: ["views", "view_count"],
  likes: ["likes", "like_count"],
  dislikes: ["dislikes", "dislike_count"],
  comment_count: ["comment_count", "comments", "comments_count"]
};

function normalizeColumnName(column) {
  const key = String(column ?? "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  for (const [target, aliases] of Object.entries(COLUMN_ALIASES)) {
    if (aliases.includes(key)) return target;
  }

  return key;
}

function getColumnValue(row, column) {
  const key = normalizeColumnName(column);

  if (row[key] !== undefined) return row[key];

  return "";
}

function normalizeRow(row) {
  const normalized = {};

  Object.keys(row).forEach(key => {
    const normalizedKey = normalizeColumnName(key);
    normalized[normalizedKey] = row[key];
  });

  Object.entries(COLUMN_ALIASES).forEach(([target, names]) => {
    if (normalized[target] === undefined) {
      const found = names.find(name => normalized[name] !== undefined);

      if (found) {
        normalized[target] = normalized[found];
      }
    }
  });

  METRICS.forEach(key => {
    normalized[key] = number(normalized[key]);
  });

  normalized.title = normalized.title || "ไม่ระบุชื่อวิดีโอ";
  normalized.channel_title = normalized.channel_title || "ไม่ระบุช่อง";
  normalized.publish_country = normalized.publish_country || "ไม่ระบุประเทศ";

  normalized.published_day_of_week =
    normalized.published_day_of_week || "ไม่ระบุวัน";

  normalized.publish_month = normalized.publish_date
    ? getMonth(normalized)
    : "ไม่ระบุเดือน";

  return normalized;
}

/* ---------- INDEXED DB ---------- */

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = event => {
      const database = event.target.result;

      if (!database.objectStoreNames.contains("datasets")) {
        database.createObjectStore("datasets", {
          keyPath: "id"
        });
      }
    };

    request.onsuccess = event => {
      db = event.target.result;
      resolve(db);
    };

    request.onerror = () => reject(request.error);
  });
}

function dbRequest(mode, action) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("datasets", mode);
    const store = transaction.objectStore("datasets");
    const request = action(store);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveDataset(name, rows, columns, id = null) {
  const dataset = {
    id: id || "ds_" + Date.now() + "_" +
      Math.random().toString(36).slice(2, 8),
    name,
    rows,
    columns,
    count: rows.length,
    updatedAt: new Date().toISOString()
  };

  await dbRequest("readwrite", store => store.put(dataset));

  return dataset;
}

async function getAllDatasets() {
  const list = await dbRequest("readonly", store => store.getAll());

  return (list || []).sort((a, b) =>
    new Date(b.updatedAt) - new Date(a.updatedAt)
  );
}

async function deleteDataset(id) {
  await dbRequest("readwrite", store => store.delete(id));
}

async function loadDataset(id) {
  try {
    const dataset = await dbRequest(
      "readonly",
      store => store.get(id)
    );

    if (!dataset) {
      notify("ไม่พบชุดข้อมูลนี้");
      return;
    }

    state.datasetId = dataset.id;
    state.datasetName = dataset.name;
    state.data = Array.isArray(dataset.rows) ? dataset.rows : [];
    state.columns = Array.isArray(dataset.columns) ? dataset.columns : [];
    state.filtered = [...state.data];
    state.page = 1;

    refreshDashboard();
    updateDatasetHeader();

    await renderDatasetList();

    notify("เปิดชุดข้อมูล " + dataset.name + " แล้ว");

  } catch (error) {
    console.error(error);
    notify("ไม่สามารถเปิดชุดข้อมูลได้");
  }
}

/* ---------- CSV IMPORT ---------- */

async function importCSV(file) {
  if (!file) return;

  if (!file.name.toLowerCase().endsWith(".csv")) {
    notify("กรุณาเลือกไฟล์ CSV เท่านั้น");
    return;
  }

  notify("กำลังอ่านไฟล์ CSV...");

  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    worker: true,

    complete: async result => {
      try {
        const originalColumns = result.meta.fields || [];

        if (!originalColumns.length || !result.data.length) {
          notify("ไม่พบข้อมูลในไฟล์ CSV");
          return;
        }

        const rows = result.data
          .filter(row =>
            Object.values(row).some(v =>
              String(v ?? "").trim() !== ""
            )
          )
          .map(normalizeRow);

        const hasMetric = originalColumns.some(col => {
          const key = normalizeColumnName(col);
          return ["views", "likes"].includes(key);
        });

        if (!hasMetric) {
          notify("ไม่พบคอลัมน์ views หรือ likes ในไฟล์");
          return;
        }

        if (!rows.length) {
          notify("ไม่พบแถวข้อมูลที่ใช้งานได้");
          return;
        }

        const defaultName = file.name.replace(/\.csv$/i, "");
        const name = prompt("ตั้งชื่อชุดข้อมูล", defaultName);

        if (name === null) return;

        const dataset = await saveDataset(
          name.trim() || defaultName,
          rows,
          originalColumns
        );

        await loadDataset(dataset.id);

        notify(
          "นำเข้าข้อมูลสำเร็จ " +
          formatNumber(rows.length) +
          " รายการ"
        );

      } catch (error) {
        console.error(error);
        notify("เกิดข้อผิดพลาดในการบันทึกข้อมูล");
      }
    },

    error: error => {
      console.error(error);
      notify("ไม่สามารถอ่านไฟล์ CSV ได้");
    }
  });
}

/* ---------- DATA SUMMARY ---------- */

function sum(rows, field) {
  return rows.reduce(
    (total, row) => total + number(row[field]),
    0
  );
}

function uniqueCount(rows, field) {
  return new Set(
    rows.map(row => row[field]).filter(Boolean)
  ).size;
}

function aggregate(rows, dimension, metric) {
  const result = {};

  rows.forEach(row => {
    let key = row[dimension];

    if (key === undefined || key === null || key === "") {
      key = "ไม่ระบุ";
    }

    key = String(key);

    result[key] = (result[key] || 0) + number(row[metric]);
  });

  return Object.entries(result).sort((a, b) => b[1] - a[1]);
}

function refreshDashboard() {
  if (!state.data.length) {
    clearDashboard();
    return;
  }

  state.filtered = [...state.data];
  state.page = 1;

  $("totalRecords").textContent = formatNumber(state.data.length);

  $("uniqueVideos").textContent = formatNumber(
    uniqueCount(state.data, "video_id")
  );

  $("totalViews").textContent = formatNumber(
    sum(state.data, "views")
  );

  $("totalLikes").textContent = formatNumber(
    sum(state.data, "likes")
  );

  $("sidebarCount").textContent =
    formatNumber(state.data.length) + " รายการ";

  buildCountryFilter();
  renderDashboardCharts();
  renderVideoTable();
  renderDataTable();
}

function buildCountryFilter() {
  const select = $("countryFilter");
  if (!select) return;

  const oldValue = select.value;

  const countries = [
    ...new Set(state.data.map(row => row.publish_country))
  ].filter(Boolean).sort();

  select.innerHTML =
    '<option value="">ทุกประเทศ</option>' +
    countries.map(country =>
      `<option value="${escapeHTML(country)}">${escapeHTML(country)}</option>`
    ).join("");

  select.value = countries.includes(oldValue) ? oldValue : "";
}

function applyCountryFilter() {
  const country = $("countryFilter").value;

  state.filtered = country
    ? state.data.filter(row => row.publish_country === country)
    : [...state.data];

  renderDashboardCharts();
  renderVideoTable();
}

/* ---------- DASHBOARD CHARTS ---------- */

function makeChart(id, type, labels, datasets, extra = {}) {
  destroyChart(id);

  const canvas = $(id);
  if (!canvas) return;

  state.charts[id] = new Chart(canvas, {
    type,
    data: {
      labels,
      datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,

      plugins: {
        legend: {
          position: "bottom",
          labels: {
            boxWidth: 10,
            font: {
              family: "Kanit"
            }
          }
        }
      },

      scales: ["pie", "doughnut", "polarArea"].includes(type)
        ? {}
        : {
            x: {
              grid: { display: false },
              ticks: {
                font: {
                  family: "Kanit",
                  size: 10
                }
              }
            },
            y: {
              beginAtZero: true,
              ticks: {
                font: {
                  family: "Kanit",
                  size: 10
                }
              }
            }
          },

      ...extra
    }
  });
}

function renderDashboardCharts() {
  const rows = state.filtered;

  const countries = aggregate(
    rows,
    "publish_country",
    "views"
  ).slice(0, 10);

  makeChart(
    "countryChart",
    "bar",
    countries.map(item => item[0]),
    [{
      label: "Views",
      data: countries.map(item => item[1]),
      backgroundColor: "#3978f6",
      borderRadius: 5
    }]
  );

  const days = aggregate(
    rows,
    "published_day_of_week",
    "views"
  );

  days.sort((a, b) => {
    const ia = DAY_ORDER.indexOf(a[0]);
    const ib = DAY_ORDER.indexOf(b[0]);

    if (ia < 0 || ib < 0) return b[1] - a[1];

    return ia - ib;
  });

  makeChart(
    "weekdayChart",
    "line",
    days.map(item => item[0]),
    [{
      label: "Views",
      data: days.map(item => item[1]),
      borderColor: "#19b9c9",
      backgroundColor: "rgba(25,185,201,.15)",
      fill: true,
      tension: .35
    }]
  );

  const engagement = [
    { label: "Likes", value: sum(rows, "likes") },
    { label: "Dislikes", value: sum(rows, "dislikes") },
    { label: "Comments", value: sum(rows, "comment_count") }
  ];

  makeChart(
    "engagementChart",
    "doughnut",
    engagement.map(item => item.label),
    [{
      data: engagement.map(item => item.value),
      backgroundColor: ["#3978f6", "#f47b7b", "#20b8a0"]
    }]
  );

  const channels = aggregate(
    rows,
    "channel_title",
    "views"
  ).slice(0, 8);

  makeChart(
    "channelChart",
    "bar",
    channels.map(item => item[0]),
    [{
      label: "Views",
      data: channels.map(item => item[1]),
      backgroundColor: "#8b73e8",
      borderRadius: 5
    }]
  );
}

/* ---------- MULTI METRIC CHART ---------- */

function generateCustomChart() {
  if (!state.data.length) {
    notify("กรุณานำเข้าข้อมูลก่อนสร้างกราฟ");
    return;
  }

  const dimension = $("xAxis").value;
  const type = $("chartType").value;
  const limit = Math.max(0, Number($("chartLimit").value) || 0);

  const metrics = [
    ...document.querySelectorAll('input[name="metric"]:checked')
  ].map(input => input.value);

  if (!metrics.length) {
    notify("กรุณาเลือกอย่างน้อยหนึ่งตัวชี้วัด");
    return;
  }

  if (metrics.some(metric => !METRICS.includes(metric))) {
    notify("พบตัวชี้วัดที่ไม่รองรับ");
    return;
  }

  if (["pie", "doughnut"].includes(type) && metrics.length > 1) {
    notify("กราฟวงกลมและโดนัทรองรับตัวชี้วัดเดียว กรุณาเลือกเพียงหนึ่งค่า");
    return;
  }

  // ใช้ข้อมูลที่ผ่านการกรองแล้ว
  const rows = state.filtered;

  if (!rows.length) {
    notify("ไม่พบข้อมูลสำหรับสร้างกราฟ");
    return;
  }

  // รวมข้อมูลตามกลุ่ม
  const grouped = {};

  rows.forEach(row => {
    let key = row[dimension];

    if (key === undefined || key === null || key === "") {
      key = "ไม่ระบุ";
    }

    key = String(key);

    if (!grouped[key]) {
      grouped[key] = {};

      METRICS.forEach(metric => {
        grouped[key][metric] = 0;
      });
    }

    metrics.forEach(metric => {
      grouped[key][metric] += number(row[metric]);
    });
  });

  // เรียงกลุ่มข้อมูล
  let groups = Object.entries(grouped);

  if (dimension === "published_day_of_week") {
    groups.sort((a, b) => {
      const ia = DAY_ORDER.indexOf(a[0]);
      const ib = DAY_ORDER.indexOf(b[0]);

      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  } else {
    const rankingMetric = metrics[0];

    groups.sort((a, b) =>
      b[1][rankingMetric] - a[1][rankingMetric]
    );
  }

  // ถ้า limit = 0 แสดงทุกกลุ่ม
  if (limit > 0) {
    groups = groups.slice(0, limit);
  }

  const colors = {
    views: "#3978f6",
    likes: "#19b9c9",
    dislikes: "#f29d49",
    comment_count: "#8b73e8"
  };

  const isDualAxis = type === "bar" || type === "line";

  const datasets = metrics.map(metric => ({
    label: LABELS[metric],

    data: groups.map(item => item[1][metric]),

    backgroundColor: colors[metric] + "CC",
    borderColor: colors[metric],
    borderWidth: 2,

    borderRadius: type === "bar" ? 5 : 0,
    tension: 0.35,
    fill: false,

    yAxisID: isDualAxis && metric !== "views" ? "y1" : "y"
  }));

  const scales = {};

  if (isDualAxis) {
    scales.x = {
      grid: {
        display: false
      },
      ticks: {
        font: {
          family: "Kanit"
        }
      }
    };

    scales.y = {
      type: "linear",
      position: "left",
      beginAtZero: true,
      title: {
        display: true,
        text: metrics.includes("views") ? "Views" : LABELS[metrics[0]]
      },
      ticks: {
        font: {
          family: "Kanit"
        }
      }
    };

    // ใช้แกนขวาเมื่อมีตัวชี้วัดอื่นนอกจาก Views
    if (metrics.some(metric => metric !== "views")) {
      scales.y1 = {
        type: "linear",
        position: "right",
        beginAtZero: true,
        title: {
          display: true,
          text: "Likes / Dislikes / Comments"
        },
        grid: {
          drawOnChartArea: false
        },
        ticks: {
          font: {
            family: "Kanit"
          }
        }
      };
    }
  }

  makeChart(
    "customChart",
    type,
    groups.map(item => item[0]),
    datasets,
    {
      scales,

      plugins: {
        legend: {
          position: "bottom",
          labels: {
            boxWidth: 10,
            font: {
              family: "Kanit"
            }
          }
        },

        tooltip: {
          callbacks: {
            label: context =>
              context.dataset.label + ": " +
              formatNumber(context.raw)
          }
        }
      }
    }
  );

  notify(
    "สร้างกราฟสำเร็จ " +
    formatNumber(groups.length) +
    " กลุ่มข้อมูล"
  );
}

/* ---------- AI ANALYSIS ---------- */

function renderAI() {
  if (!state.data.length) {
    notify("กรุณานำเข้าข้อมูลก่อน");
    return;
  }

  const rows = state.data;

  const totalViews = sum(rows, "views");
  const totalLikes = sum(rows, "likes");
  const totalComments = sum(rows, "comment_count");
  const totalDislikes = sum(rows, "dislikes");

  const countries = aggregate(rows, "publish_country", "views");
  const channels = aggregate(rows, "channel_title", "views");
  const weekdays = aggregate(rows, "published_day_of_week", "views");

  const videos = [...rows].sort((a, b) => b.views - a.views);

  const topCountry = countries[0];
  const topChannel = channels[0];
  const topDay = weekdays[0];
  const topVideo = videos[0];

  const likeRate = totalViews ? totalLikes / totalViews * 100 : 0;
  const commentRate = totalViews ? totalComments / totalViews * 100 : 0;
  const dislikeRate = totalViews ? totalDislikes / totalViews * 100 : 0;

  const cards = [
    [
      "🌍 ประเทศที่มียอดวิวสูงสุด",
      topCountry
        ? `${topCountry[0]} มียอดวิว ${formatNumber(topCountry[1])} ครั้ง`
        : "ไม่มีข้อมูลประเทศ"
    ],
    [
      "📺 ช่องยอดนิยม",
      topChannel
        ? `${topChannel[0]} มียอดวิวรวม ${formatNumber(topChannel[1])} ครั้ง`
        : "ไม่มีข้อมูลช่อง"
    ],
    [
      "📅 วันที่มียอดวิวสูง",
      topDay
        ? `${topDay[0]} มียอดวิวรวม ${formatNumber(topDay[1])} ครั้ง`
        : "ไม่มีข้อมูลวัน"
    ],
    [
      "🏆 วิดีโอยอดนิยม",
      topVideo
        ? `${topVideo.title} มียอดวิว ${formatNumber(topVideo.views)} ครั้ง`
        : "ไม่มีข้อมูลวิดีโอ"
    ],
    [
      "❤️ อัตราการกดไลก์",
      `ยอดไลก์คิดเป็น ${likeRate.toFixed(2)}% เมื่อเทียบกับยอดวิว`
    ],
    [
      "💬 อัตราการแสดงความคิดเห็น",
      `ยอดคอมเมนต์คิดเป็น ${commentRate.toFixed(2)}% เมื่อเทียบกับยอดวิว`
    ]
  ];

  $("aiResults").innerHTML = cards.map(([title, detail]) => `
    <div class="analysis-card">
      <strong>${escapeHTML(title)}</strong>
      <p>${escapeHTML(detail)}</p>
    </div>
  `).join("");

  const recommendations = [
    `• ข้อมูลชุดนี้มีทั้งหมด ${formatNumber(rows.length)} รายการ และมียอดวิวรวม ${formatNumber(totalViews)} ครั้ง`,
    `• อัตราการกดไลก์เฉลี่ยเมื่อเทียบกับยอดวิวอยู่ที่ ${likeRate.toFixed(2)}%`,
    `• อัตราการแสดงความคิดเห็นอยู่ที่ ${commentRate.toFixed(2)}%`,
    `• อัตราการกด Dislike เมื่อเทียบกับยอดวิวอยู่ที่ ${dislikeRate.toFixed(2)}%`,
    topCountry
      ? `• ควรศึกษากลุ่มผู้ชมในประเทศ ${topCountry[0]} เพิ่มเติม เนื่องจากมียอดวิวสูงสุด`
      : "",
    topChannel
      ? `• สามารถศึกษารูปแบบเนื้อหาของช่อง ${topChannel[0]} เพื่อหาแนวทางพัฒนาคอนเทนต์`
      : "",
    "• ควรเปรียบเทียบผลลัพธ์ระหว่างช่วงเวลา เพื่อค้นหาแนวโน้มการเปลี่ยนแปลง"
  ].filter(Boolean);

  $("recommendations").innerHTML = recommendations
    .map(item => `<div>${escapeHTML(item)}</div>`)
    .join("");

  notify("วิเคราะห์ข้อมูลเสร็จแล้ว");
}

/* ---------- CHATBOT ---------- */

function addMessage(text, type) {
  const messages = $("chatMessages");
  if (!messages) return;

  const div = document.createElement("div");
  div.className = "message " + type;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;

  div.appendChild(bubble);
  messages.appendChild(div);

  messages.scrollTop = messages.scrollHeight;
}

function getTop(rows, field, metric) {
  const list = aggregate(rows, field, metric);
  return list[0] || null;
}

function answerQuestion(question) {
  const q = question.toLowerCase().replace(/\s+/g, " ").trim();
  const rows = state.data;

  if (!rows.length) {
    return "ตอนนี้ยังไม่มีข้อมูลครับ กรุณานำเข้าไฟล์ CSV ก่อน แล้วผมจึงจะตอบคำถามจากข้อมูลได้";
  }

  const totalViews = sum(rows, "views");
  const totalLikes = sum(rows, "likes");
  const totalDislikes = sum(rows, "dislikes");
  const totalComments = sum(rows, "comment_count");

  const topVideo = [...rows].sort((a, b) => b.views - a.views)[0];
  const topLikeVideo = [...rows].sort((a, b) => b.likes - a.likes)[0];
  const topCommentVideo = [...rows].sort(
    (a, b) => b.comment_count - a.comment_count
  )[0];

  const topCountry = getTop(rows, "publish_country", "views");
  const topChannel = getTop(rows, "channel_title", "views");
  const topDay = getTop(rows, "published_day_of_week", "views");
  const topTime = getTop(rows, "time_frame", "views");
  const topCategory = getTop(rows, "category_id", "views");

  if (/ประเทศ|country/.test(q) && /วิว|view/.test(q)) {
    return topCountry
      ? `ประเทศที่มียอดวิวสูงที่สุดคือ ${topCountry[0]}\nยอดวิวรวม ${formatNumber(topCountry[1])} ครั้ง`
      : "ไม่พบข้อมูลประเทศ";
  }

  if (/ประเทศ|country/.test(q) && /ไลก์|like/.test(q)) {
    const result = getTop(rows, "publish_country", "likes");

    return result
      ? `${result[0]} มียอดไลก์สูงที่สุด ${formatNumber(result[1])} ครั้ง`
      : "ไม่พบข้อมูล";
  }

  if (/ช่อง|channel/.test(q) && /วิว|view/.test(q)) {
    return topChannel
      ? `ช่องที่มียอดวิวสูงที่สุดคือ ${topChannel[0]}\nยอดวิวรวม ${formatNumber(topChannel[1])} ครั้ง`
      : "ไม่พบข้อมูลช่อง";
  }

  if (/วิดีโอ|คลิป|video/.test(q) && /ไลก์|like/.test(q)) {
    return `วิดีโอที่มียอดไลก์สูงสุดคือ ${topLikeVideo.title}\nช่อง: ${topLikeVideo.channel_title}\nLikes: ${formatNumber(topLikeVideo.likes)} ครั้ง`;
  }

  if (/วิดีโอ|คลิป|video/.test(q) && /คอมเมนต์|ความคิดเห็น|comment/.test(q)) {
    return `วิดีโอที่มีคอมเมนต์สูงสุดคือ ${topCommentVideo.title}\nComments: ${formatNumber(topCommentVideo.comment_count)} ครั้ง`;
  }

  if (/วิดีโอ|คลิป|video/.test(q) && /วิว|view|ยอดนิยม|สูงสุด/.test(q)) {
    return `วิดีโอที่มียอดวิวสูงสุดคือ ${topVideo.title}\nช่อง: ${topVideo.channel_title}\nประเทศ: ${topVideo.publish_country}\nViews: ${formatNumber(topVideo.views)} ครั้ง`;
  }

  if (/วัน|weekday|day/.test(q) && /วิว|view/.test(q)) {
    return topDay
      ? `วันที่มียอดวิวสูงที่สุดคือ ${topDay[0]}\nยอดวิวรวม ${formatNumber(topDay[1])} ครั้ง`
      : "ไม่พบข้อมูลวัน";
  }

  if (/ช่วงเวลา|time frame|เวลา/.test(q) && /วิว|view/.test(q)) {
    return topTime
      ? `ช่วงเวลาที่มียอดวิวสูงที่สุดคือ ${topTime[0]}\nยอดวิว ${formatNumber(topTime[1])} ครั้ง`
      : "ไม่พบข้อมูลช่วงเวลา";
  }

  if (/หมวดหมู่|category/.test(q) && /วิว|view/.test(q)) {
    return topCategory
      ? `หมวดหมู่ที่มียอดวิวสูงที่สุดคือ ${topCategory[0]}\nยอดวิว ${formatNumber(topCategory[1])} ครั้ง`
      : "ไม่พบข้อมูลหมวดหมู่";
  }

  if (/ยอดวิวรวม|วิวรวม|total views|views ทั้งหมด/.test(q)) {
    return `ยอดวิวรวมทั้งหมดเท่ากับ ${formatNumber(totalViews)} ครั้ง`;
  }

  if (/ยอดไลก์|ไลก์รวม|likes ทั้งหมด|total likes/.test(q)) {
    return `ยอดไลก์รวมทั้งหมดเท่ากับ ${formatNumber(totalLikes)} ครั้ง`;
  }

  if (/dislike|ยอดดิสไลก์/.test(q)) {
    return `ยอด Dislikes รวมทั้งหมด ${formatNumber(totalDislikes)} ครั้ง`;
  }

  if (/คอมเมนต์รวม|ความคิดเห็นรวม|total comments/.test(q)) {
    return `ยอดคอมเมนต์รวมทั้งหมด ${formatNumber(totalComments)} ครั้ง`;
  }

  if (/เฉลี่ย|average|ค่าเฉลี่ย/.test(q) && /วิว|view/.test(q)) {
    return `ค่าเฉลี่ยยอดวิวต่อรายการคือ ${formatNumber(totalViews / rows.length)} ครั้ง`;
  }

  if (/กี่รายการ|จำนวนรายการ|กี่แถว|records|จำนวนข้อมูล/.test(q)) {
    return `ชุดข้อมูลนี้มีทั้งหมด ${formatNumber(rows.length)} รายการ`;
  }

  if (/กี่ประเทศ|จำนวนประเทศ/.test(q)) {
    return `มีประเทศทั้งหมด ${uniqueCount(rows, "publish_country")} ประเทศ`;
  }

  if (/กี่ช่อง|จำนวนช่อง/.test(q)) {
    return `มีช่อง YouTube ทั้งหมด ${uniqueCount(rows, "channel_title")} ช่อง`;
  }

  if (/สรุป|ภาพรวม|overview/.test(q)) {
    return `สรุปข้อมูล YouTube
• จำนวนรายการ: ${formatNumber(rows.length)}
• จำนวนประเทศ: ${uniqueCount(rows, "publish_country")}
• จำนวนช่อง: ${uniqueCount(rows, "channel_title")}
• ยอดวิวรวม: ${formatNumber(totalViews)}
• ยอดไลก์รวม: ${formatNumber(totalLikes)}
• คอมเมนต์รวม: ${formatNumber(totalComments)}
• ประเทศยอดนิยม: ${topCountry ? topCountry[0] : "-"}`;
  }

  return "ขออภัยครับ ผมยังไม่เข้าใจคำถามนี้ ลองถามในรูปแบบต่อไปนี้ได้ครับ\n\n• ประเทศไหนมียอดวิวสูงที่สุด\n• ช่องไหนมียอดวิวสูงสุด\n• วิดีโอไหนมีไลก์สูงสุด\n• วันไหนมียอดวิวมากที่สุด\n• ยอดวิวรวมทั้งหมดเท่าไหร่\n• มีข้อมูลทั้งหมดกี่รายการ\n• ช่วยสรุปภาพรวมข้อมูล";
}

function sendChat(question) {
  const text = question.trim();

  if (!text) return;

  addMessage(text, "user");
  $("chatInput").value = "";

  setTimeout(() => {
    addMessage(answerQuestion(text), "bot");
  }, 250);
}

/* ---------- VIDEO TABLE ---------- */

function renderVideoTable(search = "") {
  const tbody = $("videoTable");
  if (!tbody) return;

  const q = search.toLowerCase();

  const rows = [...state.filtered]
    .filter(row =>
      String(row.title).toLowerCase().includes(q) ||
      String(row.channel_title).toLowerCase().includes(q)
    )
    .sort((a, b) => b.views - a.views)
    .slice(0, 100);

  tbody.innerHTML = rows.map((row, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${escapeHTML(row.title)}</td>
      <td>${escapeHTML(row.channel_title)}</td>
      <td>${escapeHTML(row.publish_country)}</td>
      <td>${formatNumber(row.views)}</td>
      <td>${formatNumber(row.likes)}</td>
      <td>${formatNumber(row.comment_count)}</td>
    </tr>
  `).join("") || '<tr><td colspan="7">ไม่พบข้อมูล</td></tr>';
}

/* ---------- DATA TABLE ---------- */

function renderDataTable() {
  const head = $("dataHead");
  const body = $("dataTable");

  if (!head || !body) return;

  const columns = state.columns.length
    ? state.columns
    : Object.keys(state.data[0] || {});

  head.innerHTML = "<tr>" + columns.map(col =>
    `<th>${escapeHTML(col)}</th>`
  ).join("") + "</tr>";

  const query = ($("dataSearch")?.value || "").toLowerCase();

  const filtered = state.data.filter(row =>
    columns.some(col =>
      String(getColumnValue(row, col) ?? "")
        .toLowerCase()
        .includes(query)
    )
  );

  const totalPages = Math.max(
    1,
    Math.ceil(filtered.length / state.pageSize)
  );

  state.page = Math.min(state.page, totalPages);

  const start = (state.page - 1) * state.pageSize;
  const pageRows = filtered.slice(start, start + state.pageSize);

  body.innerHTML = pageRows.map(row =>
    "<tr>" + columns.map(col =>
      `<td>${escapeHTML(getColumnValue(row, col) ?? "")}</td>`
    ).join("") + "</tr>"
  ).join("") ||
    `<tr><td colspan="${columns.length || 1}">ไม่พบข้อมูล</td></tr>`;

  if ($("pageInfo")) {
    $("pageInfo").textContent =
      `หน้า ${state.page} / ${totalPages} · ${formatNumber(filtered.length)} รายการ`;
  }

  if ($("prevPage")) {
    $("prevPage").disabled = state.page <= 1;
  }

  if ($("nextPage")) {
    $("nextPage").disabled = state.page >= totalPages;
  }
}

/* ---------- DATASET MANAGEMENT ---------- */

function updateDatasetHeader() {
  if (!$("activeDatasetName")) return;

  $("activeDatasetName").textContent =
    state.datasetName || "ยังไม่มีชุดข้อมูล";
}

async function renderDatasetList() {
  const list = $("datasetList");
  if (!list) return;

  state.datasets = await getAllDatasets();

  if (!state.datasets.length) {
    list.innerHTML =
      '<div class="empty-state">ยังไม่มีชุดข้อมูล กรุณานำเข้าไฟล์ CSV</div>';
    return;
  }

  list.innerHTML = state.datasets.map(dataset => {
    const active = dataset.id === state.datasetId;

    const date = new Date(dataset.updatedAt)
      .toLocaleString("th-TH");

    return `
      <div class="dataset-item">
        <div class="dataset-icon">▤</div>

        <div class="dataset-details">
          <strong>
            ${escapeHTML(dataset.name)}
            ${active
              ? '<span class="success-badge">กำลังใช้งาน</span>'
              : ""}
          </strong>

          <small>
            ${formatNumber(dataset.count)} รายการ · ${escapeHTML(date)}
          </small>
        </div>

        <div class="dataset-actions">
          <button
            class="btn btn-primary"
            data-load="${escapeHTML(dataset.id)}"
            ${active ? "disabled" : ""}
          >
            ${active ? "กำลังใช้งาน" : "เปิดชุดข้อมูล"}
          </button>

          <button
            class="btn danger-btn"
            data-delete="${escapeHTML(dataset.id)}"
          >
            ลบ
          </button>
        </div>
      </div>
    `;
  }).join("");
}

/* ---------- PDF REPORT ---------- */

async function exportPDF() {
  if (!state.data.length) {
    notify("กรุณานำเข้าข้อมูลก่อนส่งออกรายงาน");
    return;
  }

  if (!window.jspdf || !window.html2canvas) {
    notify("ไม่สามารถโหลดระบบ PDF ได้ กรุณาตรวจสอบอินเทอร์เน็ต");
    return;
  }

  notify("กำลังสร้างรายงาน PDF...");

  try {
    const { jsPDF } = window.jspdf;

    const pdf = new jsPDF("p", "mm", "a4");
    const pageWidth = pdf.internal.pageSize.getWidth();
    const margin = 14;

    let y = 18;

    const addText = (text, size = 11, color = [45, 57, 78]) => {
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(size);
      pdf.setTextColor(...color);

      const lines = pdf.splitTextToSize(
        String(text),
        pageWidth - margin * 2
      );

      pdf.text(lines, margin, y);

      y += lines.length * (size * 0.48) + 4;
    };

    pdf.setFontSize(19);
    pdf.setTextColor(40, 93, 180);
    pdf.text("YouTube Analytics Report", margin, y);

    y += 10;

    addText("Dataset: " + state.datasetName, 11);
    addText("Generated: " + new Date().toLocaleString("th-TH"), 10);
    addText("Total records: " + formatNumber(state.data.length));
    addText("Unique videos: " + formatNumber(uniqueCount(state.data, "video_id")));
    addText("Total views: " + formatNumber(sum(state.data, "views")));
    addText("Total likes: " + formatNumber(sum(state.data, "likes")));
    addText("Total dislikes: " + formatNumber(sum(state.data, "dislikes")));
    addText("Total comments: " + formatNumber(sum(state.data, "comment_count")));

    y += 5;

    pdf.setFontSize(15);
    pdf.setTextColor(40, 93, 180);
    pdf.text("AI Data Analysis", margin, y);

    y += 9;

    const topCountry = getTop(state.data, "publish_country", "views");
    const topChannel = getTop(state.data, "channel_title", "views");
    const topDay = getTop(state.data, "published_day_of_week", "views");

    const topVideo = [...state.data]
      .sort((a, b) => b.views - a.views)[0];

    const analysis = [
      "Top country by views: " +
        (topCountry
          ? topCountry[0] + " (" + formatNumber(topCountry[1]) + ")"
          : "-"),

      "Top channel by views: " +
        (topChannel
          ? topChannel[0] + " (" + formatNumber(topChannel[1]) + ")"
          : "-"),

      "Top weekday by views: " +
        (topDay
          ? topDay[0] + " (" + formatNumber(topDay[1]) + ")"
          : "-"),

      "Top video: " +
        (topVideo
          ? topVideo.title + " (" + formatNumber(topVideo.views) + " views)"
          : "-")
    ];

    analysis.forEach(line => addText(line, 10));

    y += 4;

    pdf.setFontSize(15);
    pdf.setTextColor(40, 93, 180);
    pdf.text("Recommendations", margin, y);

    y += 9;

    [
      "Compare views, likes, dislikes and comments to understand audience engagement.",
      "Study the top-performing countries and channels.",
      "Compare publishing days and time frames to find useful patterns.",
      "Monitor engagement rates over time."
    ].forEach(line => addText("- " + line, 10));

    const chartIds = [
      "countryChart",
      "weekdayChart",
      "engagementChart",
      "channelChart"
    ];

    for (const id of chartIds) {
      const canvas = $(id);
      if (!canvas) continue;

      if (y > 235) {
        pdf.addPage();
        y = 18;
      }

      const image = await html2canvas(canvas, {
        backgroundColor: "#ffffff",
        scale: 1.5
      });

      const imgData = image.toDataURL("image/png");
      const imgWidth = pageWidth - margin * 2;
      const imgHeight = imgWidth * image.height / image.width;

      pdf.addImage(
        imgData,
        "PNG",
        margin,
        y,
        imgWidth,
        imgHeight
      );

      y += imgHeight + 8;
    }

    pdf.save("YouTube-Analytics-Report.pdf");

    notify("ส่งออกรายงาน PDF สำเร็จ");

  } catch (error) {
    console.error(error);
    notify("เกิดข้อผิดพลาดในการสร้าง PDF");
  }
}

/* ---------- NAVIGATION ---------- */

function setupNavigation() {
  document.querySelectorAll(".nav-link").forEach(button => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".nav-link").forEach(item =>
        item.classList.remove("active")
      );

      document.querySelectorAll(".page").forEach(page =>
        page.classList.remove("active")
      );

      button.classList.add("active");

      const targetPage = $("page-" + button.dataset.page);

      if (targetPage) {
        targetPage.classList.add("active");
      }

      const titles = {
        dashboard: "ภาพรวม Dashboard",
        charts: "วิเคราะห์กราฟ",
        analysis: "AI วิเคราะห์ข้อมูล",
        chatbot: "AI Chatbot",
        datasets: "จัดการชุดข้อมูล",
        videos: "วิดีโอยอดนิยม",
        data: "สำรวจข้อมูล"
      };

      if ($("pageTitle")) {
        $("pageTitle").textContent =
          titles[button.dataset.page] || "YouTube Analytics";
      }

      if (button.dataset.page === "datasets") {
        renderDatasetList();
      }
    });
  });
}

/* ---------- EVENT LISTENERS ---------- */

function setupEvents() {
  $("csvFile").addEventListener("change", event => {
    importCSV(event.target.files[0]);
    event.target.value = "";
  });

  $("newDatasetFile").addEventListener("change", event => {
    importCSV(event.target.files[0]);
    event.target.value = "";
  });

  $("countryFilter").addEventListener("change", applyCountryFilter);

  $("generateChart").addEventListener("click", generateCustomChart);

  $("runAI").addEventListener("click", renderAI);

  $("exportPDF").addEventListener("click", exportPDF);

  $("videoSearch").addEventListener("input", event => {
    renderVideoTable(event.target.value);
  });

  $("dataSearch").addEventListener("input", () => {
    state.page = 1;
    renderDataTable();
  });

  $("prevPage").addEventListener("click", () => {
    if (state.page > 1) {
      state.page--;
      renderDataTable();
    }
  });

  $("nextPage").addEventListener("click", () => {
    state.page++;
    renderDataTable();
  });

  $("chatForm").addEventListener("submit", event => {
    event.preventDefault();
    sendChat($("chatInput").value);
  });

  document.querySelectorAll(".suggestion").forEach(button => {
    button.addEventListener("click", () => {
      sendChat(button.textContent);
    });
  });

  // จัดการเปิดและลบชุดข้อมูล
  $("datasetList").addEventListener("click", async event => {
    const loadButton = event.target.closest("[data-load]");
    const deleteButton = event.target.closest("[data-delete]");

    try {
      if (loadButton) {
        await loadDataset(loadButton.dataset.load);
        return;
      }

      if (deleteButton) {
        const id = deleteButton.dataset.delete;

        const dataset = state.datasets.find(item =>
          item.id === id
        );

        if (!confirm(
          `ต้องการลบชุดข้อมูล "${dataset?.name || ""}" ใช่หรือไม่?`
        )) {
          return;
        }

        await deleteDataset(id);

        // ถ้าลบชุดที่กำลังใช้งาน ให้เปิดชุดล่าสุดที่เหลือ
        if (state.datasetId === id) {
          state.datasetId = null;
          state.datasetName = "";
          state.data = [];
          state.columns = [];
          state.filtered = [];
          state.page = 1;

          const remaining = await getAllDatasets();

          if (remaining.length) {
            await loadDataset(remaining[0].id);
          } else {
            updateDatasetHeader();
            clearDashboard();
            await renderDatasetList();
          }

        } else {
          await renderDatasetList();
        }

        notify("ลบชุดข้อมูลแล้ว");
      }

    } catch (error) {
      console.error(error);
      notify("เกิดข้อผิดพลาดในการจัดการชุดข้อมูล");
    }
  });
}

/* ---------- CLEAR DASHBOARD ---------- */

function clearDashboard() {
  if ($("totalRecords")) $("totalRecords").textContent = "0";
  if ($("uniqueVideos")) $("uniqueVideos").textContent = "0";
  if ($("totalViews")) $("totalViews").textContent = "0";
  if ($("totalLikes")) $("totalLikes").textContent = "0";
  if ($("sidebarCount")) $("sidebarCount").textContent = "0 รายการ";

  [
    "countryChart",
    "weekdayChart",
    "engagementChart",
    "channelChart",
    "customChart"
  ].forEach(destroyChart);

  if ($("videoTable")) $("videoTable").innerHTML = "";
  if ($("dataHead")) $("dataHead").innerHTML = "";
  if ($("dataTable")) $("dataTable").innerHTML = "";

  if ($("pageInfo")) $("pageInfo").textContent = "หน้า 1 / 1";

  if ($("prevPage")) $("prevPage").disabled = true;
  if ($("nextPage")) $("nextPage").disabled = true;

  if ($("aiResults")) {
    $("aiResults").innerHTML =
      '<div class="empty-state">ยังไม่มีข้อมูล</div>';
  }

  if ($("recommendations")) {
    $("recommendations").textContent = "ยังไม่มีคำแนะนำ";
  }
}

/* ---------- START APP ---------- */

async function initApp() {
  setupNavigation();
  setupEvents();

  try {
    await openDatabase();

    const datasets = await getAllDatasets();

    state.datasets = datasets;

    if (datasets.length) {
      // เปิดชุดข้อมูลล่าสุดโดยอัตโนมัติ
      await loadDataset(datasets[0].id);
    } else {
      updateDatasetHeader();
      clearDashboard();
      await renderDatasetList();
    }

  } catch (error) {
    console.error(error);
    notify("ไม่สามารถเปิดฐานข้อมูลในเบราว์เซอร์ได้");
  }
}

document.addEventListener("DOMContentLoaded", initApp);
