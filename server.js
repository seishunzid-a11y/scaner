const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');
const querystring = require('querystring');

// ==================== CONFIG ====================
const PORT = 3000;
const DB_PATH = path.join(__dirname, 'data');
const UPLOAD_PATH = path.join(__dirname, 'uploads');
const SESSION_SECRET = 'tiktokshop-scanner-secret-2024';

// ==================== DATABASE (JSON File-based) ====================
class Database {
  constructor() {
    if (!fs.existsSync(DB_PATH)) fs.mkdirSync(DB_PATH, { recursive: true });
    if (!fs.existsSync(UPLOAD_PATH)) fs.mkdirSync(UPLOAD_PATH, { recursive: true });
    this.initDB();
  }

  getFilePath(name) {
    return path.join(DB_PATH, `${name}.json`);
  }

  read(name) {
    const filePath = this.getFilePath(name);
    if (!fs.existsSync(filePath)) return [];
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  write(name, data) {
    fs.writeFileSync(this.getFilePath(name), JSON.stringify(data, null, 2));
  }

  initDB() {
    if (!fs.existsSync(this.getFilePath('users'))) {
      const users = [
        { id: this.generateId(), username: 'admin', password: this.hashPassword('admin123'), role: 'admin', name: 'Administrator', createdAt: new Date().toISOString() },
        { id: this.generateId(), username: 'packing', password: this.hashPassword('packing123'), role: 'packing', name: 'Staff Packing', createdAt: new Date().toISOString() }
      ];
      this.write('users', users);
    }
    if (!fs.existsSync(this.getFilePath('products'))) this.write('products', []);
    if (!fs.existsSync(this.getFilePath('scan_history'))) this.write('scan_history', []);
    if (!fs.existsSync(this.getFilePath('orders'))) this.write('orders', []);
  }

  generateId() { return crypto.randomBytes(8).toString('hex'); }
  hashPassword(password) { return crypto.createHash('sha256').update(password + SESSION_SECRET).digest('hex'); }
  verifyPassword(password, hash) { return this.hashPassword(password) === hash; }
}

const db = new Database();

// ==================== SESSION MANAGEMENT ====================
const sessions = {};

function createSession(user) {
  const sessionId = crypto.randomBytes(32).toString('hex');
  sessions[sessionId] = { userId: user.id, username: user.username, role: user.role, name: user.name, createdAt: Date.now() };
  return sessionId;
}

function getSession(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies['session_id'];
  if (sessionId && sessions[sessionId]) return sessions[sessionId];
  return null;
}

function destroySession(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies['session_id'];
  if (sessionId) delete sessions[sessionId];
}

function parseCookies(req) {
  const cookies = {};
  const cookieHeader = req.headers.cookie || '';
  cookieHeader.split(';').forEach(cookie => {
    const [name, value] = cookie.trim().split('=');
    if (name) cookies[name] = decodeURIComponent(value || '');
  });
  return cookies;
}

// ==================== MULTIPART PARSER ====================
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const boundary = req.headers['content-type'].split('boundary=')[1];
    if (!boundary) return resolve({ fields: {}, files: [] });

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const content = buffer.toString('binary');
      const parts = content.split('--' + boundary).slice(1, -1);
      const fields = {};
      const files = [];

      parts.forEach(part => {
        const headerEnd = part.indexOf('\r\n\r\n');
        const header = part.substring(0, headerEnd);
        const body = part.substring(headerEnd + 4, part.length - 2);

        const nameMatch = header.match(/name="([^"]+)"/);
        const filenameMatch = header.match(/filename="([^"]+)"/);

        if (filenameMatch && nameMatch) {
          const filename = filenameMatch[1];
          const fileBuffer = Buffer.from(body, 'binary');
          files.push({ fieldName: nameMatch[1], filename, data: fileBuffer });
        } else if (nameMatch) {
          fields[nameMatch[1]] = body.trim();
        }
      });

      resolve({ fields, files });
    });
    req.on('error', reject);
  });
}

// ==================== CSV PARSER (TikTok Shop format) ====================
function parseCSV(content) {
  const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 2) return [];

  // Parse header
  const headers = parseCSVLine(lines[0]);
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => { row[h.trim()] = (values[idx] || '').trim(); });
    rows.push(row);
  }
  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if ((char === ',' || char === ';' || char === '\t') && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

// Map TikTok Shop CSV columns to our order format
function mapTikTokCSVToOrders(rows) {
  const orders = [];
  const columnMappings = {
    orderNumber: ['order_id', 'order_sn', 'no_pesanan', 'nomor_pesanan', 'order number', 'id pesanan', 'order id'],
    resiNumber: ['tracking_number', 'no_resi', 'nomor_resi', 'tracking number', 'resi', 'awb', 'nomor resi'],
    buyerName: ['buyer_name', 'nama_pembeli', 'recipient_name', 'nama penerima', 'buyer name', 'penerima', 'nama pembeli'],
    buyerPhone: ['buyer_phone', 'phone', 'telepon', 'no_telepon', 'nomor telepon', 'buyer phone', 'no telepon penerima', 'no hp'],
    buyerAddress: ['address', 'alamat', 'alamat_pengiriman', 'shipping_address', 'alamat pengiriman', 'detail alamat'],
    buyerCity: ['city', 'kota', 'kabupaten', 'kota/kabupaten'],
    buyerProvince: ['province', 'provinsi'],
    buyerPostalCode: ['postal_code', 'kode_pos', 'zip', 'kode pos'],
    courier: ['courier', 'kurir', 'shipping_provider', 'jasa kirim', 'ekspedisi', 'opsi pengiriman'],
    productName: ['product_name', 'nama_produk', 'item_name', 'nama produk', 'nama barang', 'produk'],
    sku: ['sku', 'seller_sku', 'sku penjual', 'sku induk'],
    quantity: ['quantity', 'qty', 'jumlah'],
    weight: ['weight', 'berat', 'berat produk'],
    productPrice: ['price', 'harga', 'harga asal', 'harga jual', 'total harga']
  };

  rows.forEach(row => {
    const order = {};
    const rowKeys = Object.keys(row).map(k => k.toLowerCase().trim());

    Object.entries(columnMappings).forEach(([field, possibleNames]) => {
      for (const name of possibleNames) {
        const matchIdx = rowKeys.findIndex(k => k === name || k.includes(name));
        if (matchIdx !== -1) {
          const actualKey = Object.keys(row)[matchIdx];
          order[field] = row[actualKey] || '';
          break;
        }
      }
      if (!order[field]) order[field] = '';
    });

    // Only add if has meaningful data
    if (order.orderNumber || order.resiNumber || order.buyerName) {
      order.quantity = parseInt(order.quantity) || 1;
      order.weight = parseFloat(order.weight) || 0.5;
      orders.push(order);
    }
  });

  return orders;
}

// ==================== HELPER FUNCTIONS ====================
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      try {
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('application/json')) {
          resolve(JSON.parse(body));
        } else {
          resolve(querystring.parse(body));
        }
      } catch (e) { resolve({}); }
    });
  });
}

function sendJSON(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendHTML(res, html, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function redirect(res, location) {
  res.writeHead(302, { 'Location': location });
  res.end();
}

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  const mimeTypes = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
  const contentType = mimeTypes[ext] || 'text/plain';
  if (fs.existsSync(filePath)) {
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(fs.readFileSync(filePath));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
}

function renderTemplate(templateName, data = {}) {
  const templatePath = path.join(__dirname, 'views', `${templateName}.html`);
  let html = fs.readFileSync(templatePath, 'utf8');
  Object.keys(data).forEach(key => {
    html = html.replace(new RegExp(`{{${key}}}`, 'g'), data[key]);
  });
  return html;
}

// ==================== ROUTES ====================
async function handleRequest(req, res) {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // Serve static files
  if (pathname.startsWith('/public/')) {
    return serveStatic(res, path.join(__dirname, pathname));
  }

  // ===== AUTH ROUTES =====
  if (pathname === '/' || pathname === '/login') {
    if (method === 'GET') {
      const session = getSession(req);
      if (session) return redirect(res, session.role === 'admin' ? '/admin/dashboard' : '/packing/scan');
      return sendHTML(res, renderTemplate('login'));
    }
  }

  if (pathname === '/api/login' && method === 'POST') {
    const body = await parseBody(req);
    const users = db.read('users');
    const user = users.find(u => u.username === body.username);
    if (!user || !db.verifyPassword(body.password, user.password)) {
      return sendJSON(res, { success: false, message: 'Username atau password salah' }, 401);
    }
    const sessionId = createSession(user);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `session_id=${sessionId}; Path=/; HttpOnly` });
    return res.end(JSON.stringify({ success: true, redirect: user.role === 'admin' ? '/admin/dashboard' : '/packing/scan' }));
  }

  if (pathname === '/logout') {
    destroySession(req);
    res.writeHead(302, { 'Location': '/login', 'Set-Cookie': 'session_id=; Path=/; HttpOnly; Max-Age=0' });
    return res.end();
  }

  // ===== PROTECTED ROUTES =====
  const session = getSession(req);
  if (!session) {
    if (method === 'GET') return redirect(res, '/login');
    return sendJSON(res, { success: false, message: 'Unauthorized' }, 401);
  }

  // ===== ADMIN PAGE ROUTES =====
  if (pathname === '/admin/dashboard' && session.role === 'admin') {
    const products = db.read('products');
    const scanHistory = db.read('scan_history');
    const orders = db.read('orders');
    const today = new Date().toISOString().split('T')[0];
    const todayScans = scanHistory.filter(s => s.scannedAt.startsWith(today));
    const pendingOrders = orders.filter(o => o.status === 'pending');
    return sendHTML(res, renderTemplate('admin_dashboard', {
      userName: session.name,
      totalProducts: products.length,
      totalStock: products.reduce((sum, p) => sum + p.stock, 0),
      todayScans: todayScans.length,
      todayItemsOut: todayScans.reduce((sum, s) => sum + s.quantity, 0),
      pendingOrders: pendingOrders.length,
      totalOrders: orders.length
    }));
  }

  if (pathname === '/admin/products' && session.role === 'admin') {
    return sendHTML(res, renderTemplate('admin_products', { userName: session.name }));
  }

  if (pathname === '/admin/upload' && session.role === 'admin') {
    return sendHTML(res, renderTemplate('admin_upload', { userName: session.name }));
  }

  if (pathname === '/admin/orders' && session.role === 'admin') {
    return sendHTML(res, renderTemplate('admin_orders', { userName: session.name }));
  }

  if (pathname === '/admin/reports' && session.role === 'admin') {
    return sendHTML(res, renderTemplate('admin_reports', { userName: session.name }));
  }

  // ===== UPLOAD API (Admin upload CSV/PDF resi from TikTok) =====
  if (pathname === '/api/upload-resi' && method === 'POST' && session.role === 'admin') {
    try {
      const { fields, files } = await parseMultipart(req);
      if (files.length === 0) {
        return sendJSON(res, { success: false, message: 'Tidak ada file yang diupload' }, 400);
      }

      const file = files[0];
      const ext = path.extname(file.filename).toLowerCase();
      let parsedOrders = [];

      if (ext === '.csv' || ext === '.txt') {
        const content = file.data.toString('utf8');
        const rows = parseCSV(content);
        parsedOrders = mapTikTokCSVToOrders(rows);
      } else if (ext === '.pdf') {
        // For PDF, we extract text-like content (basic approach)
        // In production, you'd use a PDF parser library
        const content = file.data.toString('utf8');
        // Try to find CSV-like content in PDF
        const textContent = content.replace(/[^\x20-\x7E\n\r\t]/g, ' ').replace(/\s+/g, ' ');
        return sendJSON(res, { 
          success: false, 
          message: 'Format PDF belum didukung sepenuhnya. Silakan export dari TikTok Shop sebagai CSV/Excel terlebih dahulu.' 
        }, 400);
      } else {
        return sendJSON(res, { success: false, message: 'Format file tidak didukung. Gunakan CSV.' }, 400);
      }

      if (parsedOrders.length === 0) {
        return sendJSON(res, { success: false, message: 'Tidak ada data pesanan yang valid ditemukan dalam file.' }, 400);
      }

      // Save orders to database
      const orders = db.read('orders');
      const newOrders = [];
      let duplicates = 0;

      parsedOrders.forEach(po => {
        // Check duplicate by orderNumber or resiNumber
        const exists = orders.find(o => 
          (po.orderNumber && o.orderNumber === po.orderNumber) ||
          (po.resiNumber && o.resiNumber === po.resiNumber)
        );
        if (exists) {
          duplicates++;
          return;
        }

        const newOrder = {
          id: db.generateId(),
          orderNumber: po.orderNumber,
          resiNumber: po.resiNumber,
          buyerName: po.buyerName,
          buyerPhone: po.buyerPhone,
          buyerAddress: po.buyerAddress,
          buyerCity: po.buyerCity,
          buyerProvince: po.buyerProvince,
          buyerPostalCode: po.buyerPostalCode,
          courier: po.courier || 'J&T Express',
          productName: po.productName,
          sku: po.sku || '',
          quantity: po.quantity || 1,
          weight: po.weight || 0.5,
          productPrice: po.productPrice || '',
          shopName: fields.shopName || 'TikTok Shop',
          shopPhone: fields.shopPhone || '',
          shopAddress: fields.shopAddress || '',
          status: 'pending', // pending, packed, shipped
          scannedAt: null,
          scannedBy: null,
          createdBy: session.username,
          createdAt: new Date().toISOString(),
          source: 'upload'
        };
        newOrders.push(newOrder);
        orders.push(newOrder);
      });

      db.write('orders', orders);

      // Save upload log
      const uploadLog = {
        filename: file.filename,
        uploadedBy: session.username,
        uploadedAt: new Date().toISOString(),
        totalRows: parsedOrders.length,
        imported: newOrders.length,
        duplicates: duplicates
      };

      return sendJSON(res, { 
        success: true, 
        data: {
          imported: newOrders.length,
          duplicates: duplicates,
          total: parsedOrders.length,
          orders: newOrders
        },
        message: `Berhasil import ${newOrders.length} pesanan.${duplicates > 0 ? ` (${duplicates} duplikat dilewati)` : ''}`
      });
    } catch (err) {
      return sendJSON(res, { success: false, message: 'Gagal memproses file: ' + err.message }, 500);
    }
  }

  // ===== PRODUCTS API =====
  if (pathname === '/api/products' && method === 'GET') {
    return sendJSON(res, { success: true, data: db.read('products') });
  }

  if (pathname === '/api/products' && method === 'POST' && session.role === 'admin') {
    const body = await parseBody(req);
    const products = db.read('products');
    const newProduct = {
      id: db.generateId(), sku: body.sku || '', name: body.name,
      description: body.description || '', price: parseFloat(body.price) || 0,
      stock: parseInt(body.stock) || 0, barcode: body.barcode || body.sku || '',
      weight: parseFloat(body.weight) || 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    products.push(newProduct);
    db.write('products', products);
    return sendJSON(res, { success: true, data: newProduct });
  }

  if (pathname.startsWith('/api/products/') && method === 'PUT' && session.role === 'admin') {
    const productId = pathname.split('/')[3];
    const body = await parseBody(req);
    const products = db.read('products');
    const index = products.findIndex(p => p.id === productId);
    if (index === -1) return sendJSON(res, { success: false, message: 'Produk tidak ditemukan' }, 404);
    products[index] = { ...products[index], sku: body.sku || products[index].sku, name: body.name || products[index].name,
      description: body.description || products[index].description, price: parseFloat(body.price) || products[index].price,
      stock: parseInt(body.stock) ?? products[index].stock, barcode: body.barcode || products[index].barcode,
      weight: parseFloat(body.weight) || products[index].weight, updatedAt: new Date().toISOString() };
    db.write('products', products);
    return sendJSON(res, { success: true, data: products[index] });
  }

  if (pathname.startsWith('/api/products/') && method === 'DELETE' && session.role === 'admin') {
    const productId = pathname.split('/')[3];
    let products = db.read('products');
    products = products.filter(p => p.id !== productId);
    db.write('products', products);
    return sendJSON(res, { success: true });
  }

  // ===== ORDERS API =====
  if (pathname === '/api/orders' && method === 'GET') {
    const orders = db.read('orders');
    const status = parsedUrl.query.status;
    if (status) {
      return sendJSON(res, { success: true, data: orders.filter(o => o.status === status) });
    }
    return sendJSON(res, { success: true, data: orders });
  }

  if (pathname === '/api/orders' && method === 'POST') {
    const body = await parseBody(req);
    const orders = db.read('orders');
    const newOrder = {
      id: db.generateId(), orderNumber: body.orderNumber || '', resiNumber: body.resiNumber || '',
      buyerName: body.buyerName || '', buyerPhone: body.buyerPhone || '',
      buyerAddress: body.buyerAddress || '', buyerCity: body.buyerCity || '',
      buyerProvince: body.buyerProvince || '', buyerPostalCode: body.buyerPostalCode || '',
      courier: body.courier || 'J&T Express', productName: body.productName || '',
      sku: body.sku || '', quantity: parseInt(body.quantity) || 1,
      weight: parseFloat(body.weight) || 0.5, shopName: body.shopName || 'TikTok Shop',
      shopPhone: body.shopPhone || '', shopAddress: body.shopAddress || '',
      notes: body.notes || '', status: 'pending', scannedAt: null, scannedBy: null,
      createdBy: session.username, createdAt: new Date().toISOString(), source: 'manual'
    };
    orders.push(newOrder);
    db.write('orders', orders);
    return sendJSON(res, { success: true, data: newOrder });
  }

  if (pathname.startsWith('/api/orders/') && pathname.endsWith('/pack') && method === 'POST') {
    // Mark order as packed (after scan)
    const orderId = pathname.split('/')[3];
    const orders = db.read('orders');
    const index = orders.findIndex(o => o.id === orderId);
    if (index === -1) return sendJSON(res, { success: false, message: 'Pesanan tidak ditemukan' }, 404);
    orders[index].status = 'packed';
    orders[index].scannedAt = new Date().toISOString();
    orders[index].scannedBy = session.username;
    db.write('orders', orders);
    return sendJSON(res, { success: true, data: orders[index] });
  }

  if (pathname.startsWith('/api/orders/') && method === 'DELETE') {
    const orderId = pathname.split('/')[3];
    let orders = db.read('orders');
    orders = orders.filter(o => o.id !== orderId);
    db.write('orders', orders);
    return sendJSON(res, { success: true });
  }

  // ===== SCAN / PACKING =====
  if (pathname === '/packing/scan') {
    return sendHTML(res, renderTemplate('packing_scan', { userName: session.name, userRole: session.role }));
  }

  if (pathname === '/api/scan' && method === 'POST') {
    const body = await parseBody(req);
    const barcode = body.barcode;
    const quantity = parseInt(body.quantity) || 1;
    const orderId = body.orderId || null; // optional: link to specific order

    const products = db.read('products');
    const product = products.find(p => p.barcode === barcode || p.sku === barcode);

    if (!product) {
      return sendJSON(res, { success: false, message: 'Produk tidak ditemukan dengan barcode/SKU: ' + barcode }, 404);
    }
    if (product.stock < quantity) {
      return sendJSON(res, { success: false, message: `Stok tidak cukup! Stok tersedia: ${product.stock}` }, 400);
    }

    // Kurangi stok
    const productIndex = products.findIndex(p => p.id === product.id);
    const stockBefore = products[productIndex].stock;
    products[productIndex].stock -= quantity;
    products[productIndex].updatedAt = new Date().toISOString();
    db.write('products', products);

    // Catat scan history
    const scanHistory = db.read('scan_history');
    const scanRecord = {
      id: db.generateId(), productId: product.id, productName: product.name,
      sku: product.sku, barcode: barcode, quantity: quantity,
      stockBefore: stockBefore, stockAfter: products[productIndex].stock,
      orderId: orderId, scannedBy: session.username, scannedByName: session.name,
      scannedAt: new Date().toISOString()
    };
    scanHistory.push(scanRecord);
    db.write('scan_history', scanHistory);

    // If orderId provided, mark that order as packed
    if (orderId) {
      const orders = db.read('orders');
      const oIdx = orders.findIndex(o => o.id === orderId);
      if (oIdx !== -1) {
        orders[oIdx].status = 'packed';
        orders[oIdx].scannedAt = new Date().toISOString();
        orders[oIdx].scannedBy = session.username;
        db.write('orders', orders);
      }
    }

    return sendJSON(res, {
      success: true,
      data: { product: products[productIndex], scan: scanRecord },
      message: `Berhasil scan keluar: ${product.name} (${quantity} pcs). Sisa stok: ${products[productIndex].stock}`
    });
  }

  // ===== CETAK RESI =====
  if (pathname === '/packing/resi' || (pathname === '/admin/resi' && session.role === 'admin')) {
    return sendHTML(res, renderTemplate('cetak_resi', { userName: session.name, userRole: session.role }));
  }

  // ===== REPORTS =====
  if (pathname === '/api/reports/daily' && method === 'GET') {
    const date = parsedUrl.query.date || new Date().toISOString().split('T')[0];
    const scanHistory = db.read('scan_history');
    const dailyScans = scanHistory.filter(s => s.scannedAt.startsWith(date));
    return sendJSON(res, { success: true, data: { date, totalScans: dailyScans.length, totalItemsOut: dailyScans.reduce((sum, s) => sum + s.quantity, 0), scans: dailyScans } });
  }

  if (pathname === '/api/reports/stock' && method === 'GET') {
    return sendJSON(res, { success: true, data: db.read('products') });
  }

  if (pathname === '/api/scan-history' && method === 'GET') {
    const scanHistory = db.read('scan_history');
    const limit = parseInt(parsedUrl.query.limit) || 50;
    return sendJSON(res, { success: true, data: scanHistory.slice(-limit).reverse() });
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<h1>404 - Halaman tidak ditemukan</h1><a href="/">Kembali ke beranda</a>');
}

// ==================== START SERVER ====================
const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`Server berjalan di http://localhost:${PORT}`);
  console.log(`Database path: ${DB_PATH}`);
  console.log(`Default admin: admin / admin123`);
  console.log(`Default packing: packing / packing123`);
});
