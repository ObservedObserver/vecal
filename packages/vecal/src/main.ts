import { VectorDB } from './index';

interface HNStory {
  id: number;
  title: string;
  url?: string;
  by: string;
  score: number;
}

const apiKeyInput = document.getElementById('apiKey') as HTMLInputElement;
const saveKeyBtn = document.getElementById('saveKey') as HTMLButtonElement;
const loadBtn = document.getElementById('loadStories') as HTMLButtonElement;
const searchInput = document.getElementById('searchInput') as HTMLInputElement;
const searchBtn = document.getElementById('searchBtn') as HTMLButtonElement;
const statusDiv = document.getElementById('status') as HTMLDivElement;
const tableBody = document.getElementById('storyBody') as HTMLTableSectionElement;
const simHeader = document.getElementById('similarityHeader') as HTMLTableCellElement;

let db: VectorDB | null = null;
let dimension = 0;

function setStatus(msg: string) {
  statusDiv.textContent = msg;
}

function loadStoredKey() {
  const k = localStorage.getItem('openaiKey') || '';
  apiKeyInput.value = k;
}

loadStoredKey();

function renderRow(story: HNStory, similarity?: number) {
  const tr = document.createElement('tr');
  const titleTd = document.createElement('td');
  const a = document.createElement('a');
  a.href = story.url || `https://news.ycombinator.com/item?id=${story.id}`;
  a.textContent = story.title;
  a.target = '_blank';
  titleTd.appendChild(a);
  titleTd.className = 'px-3 py-2';

  const scoreTd = document.createElement('td');
  scoreTd.textContent = String(story.score);
  scoreTd.className = 'px-3 py-2';

  const byTd = document.createElement('td');
  byTd.textContent = story.by;
  byTd.className = 'px-3 py-2';

  tr.appendChild(titleTd);
  tr.appendChild(scoreTd);
  tr.appendChild(byTd);

  if (similarity !== undefined) {
    const simTd = document.createElement('td');
    simTd.textContent = similarity.toFixed(2);
    simTd.className = 'px-3 py-2';
    tr.appendChild(simTd);
  }

  tableBody.appendChild(tr);
}

saveKeyBtn.onclick = () => {
  localStorage.setItem('openaiKey', apiKeyInput.value.trim());
  setStatus('API key saved');
};

async function fetchEmbedding(text: string, key: string): Promise<Float32Array> {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text })
  });
  const json = await res.json();
  const emb: number[] = json.data[0].embedding;
  return Float32Array.from(emb);
}


loadBtn.onclick = async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    setStatus('Please enter API key');
    return;
  }
  setStatus('Loading stories...');
  if (db) {
    await db.close();
    indexedDB.deleteDatabase('hn-stories');
  }
  db = null;
  tableBody.innerHTML = '';
  simHeader.classList.add('hidden');

  const idsRes = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
  const ids: number[] = await idsRes.json();
  const top = ids.slice(0, 30);
  let count = 0;

  for (const id of top) {
    setStatus(`Loading ${count + 1}/${top.length} stories...`);
    const r = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
    const story: HNStory = await r.json();
    renderRow(story);

    const vec = await fetchEmbedding(story.title, key);
    if (!db) {
      dimension = vec.length;
      db = new VectorDB({ dbName: 'hn-stories', dimension });
    }
    await db.add(vec, {
      title: story.title,
      url: story.url || `https://news.ycombinator.com/item?id=${story.id}`,
      by: story.by,
      score: story.score
    });
    count++;
  }

  setStatus(`Indexed ${count} stories`);
};

searchBtn.onclick = async () => {
  if (!db) {
    setStatus('Load stories first');
    return;
  }
  const key = apiKeyInput.value.trim();
  if (!key) {
    setStatus('Please enter API key');
    return;
  }
  const query = searchInput.value;
  if (!query) return;
  setStatus('Searching...');
  const vec = await fetchEmbedding(query, key);
  const results = await db.search(vec, 5);
  tableBody.innerHTML = '';
  simHeader.classList.remove('hidden');
  for (const r of results) {
    const meta = r.metadata as HNStory | undefined;
    if (!meta) continue;
    renderRow(meta, r.score);
  }
  setStatus(`Found ${results.length} results`);
};
