import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { rename } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const HOST = process.env.BT885_FTP_HOST || "ftp.uniden.com";
const USER = process.env.BT885_FTP_USER || "BT885ftp2";
const PASS = process.env.BT885_FTP_PASS || "89jZ53Ba";
const REMOTE_DIR = process.env.BT885_FTP_DIR || "/BT885";
const TIMEOUT_MS = 25000;

function parseStamp(name) {
  const m = String(name).match(/(\d{1,2})_(\d{1,2})_(\d{4})/);
  if (!m) return 0;
  return Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
}

function latestName(names) {
  const files = names
    .map((name) => path.basename(String(name).trim()))
    .filter((name) => /^MasterHpdb_.*\.gz$/i.test(name));
  files.sort((a, b) => parseStamp(a) - parseStamp(b));
  return files[files.length - 1] || null;
}

function connect(host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`ftp timeout ${host}:${port}`));
    }, TIMEOUT_MS);
    sock.once("connect", () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function readReply(session) {
  return new Promise((resolve, reject) => {
    session.pending.push({ resolve, reject });
    flush(session);
  });
}

function flush(session) {
  while (session.pending.length) {
    const lines = session.buf.split("\r\n");
    if (lines.length < 2) return;
    let complete = -1;
    let acc = "";
    for (let i = 0; i < lines.length - 1; i += 1) {
      const line = lines[i];
      acc += `${line}\r\n`;
      if (/^\d{3} /.test(line)) {
        complete = i;
        break;
      }
    }
    if (complete < 0) return;
    session.buf = lines.slice(complete + 1).join("\r\n");
    const { resolve } = session.pending.shift();
    resolve(acc);
  }
}

async function cmd(session, line) {
  session.sock.write(`${line}\r\n`);
  const text = await readReply(session);
  const code = Number(text.slice(0, 3));
  if (code >= 400) throw new Error(text.trim().slice(0, 180));
  return { code, text };
}

function parsePasv(text) {
  const m = text.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
  if (!m) throw new Error("ftp PASV failed");
  return {
    host: `${m[1]}.${m[2]}.${m[3]}.${m[4]}`,
    port: Number(m[5]) * 256 + Number(m[6]),
  };
}

async function openSession() {
  const sock = await connect(HOST, 21);
  const session = { sock, buf: "", pending: [] };
  sock.setEncoding("utf8");
  sock.on("data", (chunk) => {
    session.buf += chunk;
    flush(session);
  });
  sock.on("error", (err) => {
    for (const item of session.pending) item.reject(err);
    session.pending.length = 0;
  });
  const hello = await readReply(session);
  if (!hello.startsWith("220")) throw new Error(hello.trim().slice(0, 180));
  await cmd(session, `USER ${USER}`);
  await cmd(session, `PASS ${PASS}`);
  await cmd(session, `CWD ${REMOTE_DIR}`);
  await cmd(session, "TYPE I");
  return session;
}

async function pasvSocket(session) {
  const reply = await cmd(session, "PASV");
  const { host, port } = parsePasv(reply.text);
  return connect(host, port);
}

async function nlst(session) {
  const data = await pasvSocket(session);
  const chunks = [];
  data.on("data", (chunk) => chunks.push(chunk));
  const closed = new Promise((resolve, reject) => {
    data.once("error", reject);
    data.once("end", resolve);
    data.once("close", resolve);
  });
  await cmd(session, "NLST");
  await closed;
  await readReply(session);
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function retr(session, name, dest) {
  mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const data = await pasvSocket(session);
  const out = createWriteStream(part);
  const done = new Promise((resolve, reject) => {
    data.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
    data.pipe(out);
  });
  await cmd(session, `RETR ${name}`);
  await done;
  await readReply(session);
  await rename(part, dest);
}

export async function fetchLatestHpdb(dir) {
  const session = await openSession();
  try {
    const name = latestName(await nlst(session));
    if (!name) throw new Error("Uniden FTP has no MasterHpdb_*.gz");
    const dest = path.join(dir, name);
    if (existsSync(dest) && statSync(dest).size > 1000) return dest;
    await retr(session, name, dest);
    if (!existsSync(dest) || statSync(dest).size < 1000) {
      throw new Error(`downloaded ${name} was empty`);
    }
    return dest;
  } finally {
    try {
      session.sock.end();
    } catch {
      session.sock.destroy();
    }
  }
}

export { parseStamp, latestName };
