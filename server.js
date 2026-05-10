const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');
const querystring = require('querystring');

// ==================== CONFIG ====================
const PORT = 3000;
const DB_PATH = path.join(__dirname, 'data');
const SESSION_SECRET = 'tiktokshop-scanner-secret-2024';

// ==================== DATABASE (JSON File-based) ====================
class Database {
  constructor() {
    if (!fs.existsSync(DB_PATH)) fs.mkdirSync(DB_PATH, { recursive: true });
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
    // Initialize users if not exists
    if (!fs.existsSync(this.getFilePath('users'))) {
      const users = [
        {
          id: this.generateId(),
          username: 'admin',
          password: this.hashPassword('admin123'),
          role: 'admin',
          name: 'Administrator',
          createdAt: new Date().toISOString()
        },
        {
          id: this.generateId(),
          username: 'packing',
          password: this.hashPassword('packing123'),
          role: 'packing',
          name: 'Staff Packing',
          createdAt: new Date().toISOString()
        }
      ];
      this.write('users', users);
    }
    // Initialize products if not exists
    if (!fs.existsSync(this.getFilePath('products'))) {
      this.write('products', []);
    }
    // Initialize scan_history if not exists
    if (!fs.existsSync(this.getFilePath('scan_history'))) {
      this.write('scan_history', []);
    }
    // Initialize orders if not exists
    if (!fs.existsSync(this.getFilePath('orders'))) {
      this.write('orders', []);
    }
  }

  generateId() {
    return crypto.randomBytes(8).toString('hex');
  }

  hashPassword(password) {
    return crypto.createHash('sha256').update(password + SESSION_SECRET).digest('hex');
  }

  verifyPassword(password, hash) {
    return this.hashPassword(password) === hash;
  }
}

const db = new Database();

// ==================== SESSION MANAGEMENT ====================
const sessions = {};

function createSession(user) {
  const sessionId = crypto.randomBytes(32).toString('hex');
  sessions[sessionId] = {
    userId: user.id,
    username: user.username,
    role: user.role,
    name: user.name,
    createdAt: Date.now()
  };
  return sessionId;
}

function getSession(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies['session_id'];
  if (sessionId && sessions[sessionId]) {
    return sessions[sessionId];
  }
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
      } catch (e) {
        resolve({});
      }
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
  const mimeTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml'
  };
  const contentType = mimeTypes[ext] || 'text/plain';
  
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
}

// ==================== TEMPLATE ENGINE ====================
function renderTemplate(templateName, data = {}) {
  const templatePath = path.join(__dirname, 'views', `${templateName}.html`);
  let html = fs.readFileSync(templatePath, 'utf8');
  
  // Simple template replacement {{variable}}
  Object.keys(data).forEach(key => {
    const regex = new RegExp(`{{${key}}}`, 'g');
    html = html.replace(regex, data[key]);
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
    const filePath = path.join(__dirname, pathname);
    return serveStatic(res, filePath);
  }

  // ===== AUTH ROUTES =====
  if (pathname === '/' || pathname === '/login') {
    if (method === 'GET') {
      const session = getSession(req);
      if (session) {
        return redirect(res, session.role === 'admin' ? '/admin/dashboard' : '/packing/scan');
      }
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
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': `session_id=${sessionId}; Path=/; HttpOnly`
    });
    return res.end(JSON.stringify({ 
      success: true, 
      redirect: user.role === 'admin' ? '/admin/dashboard' : '/packing/scan' 
    }));
  }

  if (pathname === '/logout') {
    destroySession(req);
    res.writeHead(302, {
      'Location': '/login',
      'Set-Cookie': 'session_id=; Path=/; HttpOnly; Max-Age=0'
    });
    return res.end();
  }

  // ===== PROTECTED ROUTES =====
  const session = getSession(req);
  if (!session) {
    if (method === 'GET') return redirect(res, '/login');
    return sendJSON(res, { success: false, message: 'Unauthorized' }, 401);
  }

  // ===== ADMIN ROUTES =====
  if (pathname === '/admin/dashboard' && session.role === 'admin') {
    const products = db.read('products');
    const scanHistory = db.read('scan_history');
    const today = new Date().toISOString().split('T')[0];
    const todayScans = scanHistory.filter(s => s.scannedAt.startsWith(today));
    
    return sendHTML(res, renderTemplate('admin_dashboard', {
      userName: session.name,
      totalProducts: products.length,
      totalStock: products.reduce((sum, p) => sum + p.stock, 0),
      todayScans: todayScans.length,
      todayItemsOut: todayScans.reduce((sum, s) => sum + s.quantity, 0)
    }));
  }

  if (pathname === '/admin/products' && session.role === 'admin') {
    return sendHTML(res, renderTemplate('admin_products', { userName: session.name }));
  }

  if (pathname === '/admin/reports' && session.role === 'admin') {
    return sendHTML(res, renderTemplate('admin_reports', { userName: session.name }));
  }

  // ===== ADMIN API =====
  if (pathname === '/api/products' && method === 'GET') {
    const products = db.read('products');
    return sendJSON(res, { success: true, data: products });
  }

  if (pathname === '/api/products' && method === 'POST' && session.role === 'admin') {
    const body = await parseBody(req);
    const products = db.read('products');
    
    const newProduct = {
      id: db.generateId(),
      sku: body.sku || '',
      name: body.name,
      description: body.description || '',
      price: parseFloat(body.price) || 0,
      stock: parseInt(body.stock) || 0,
      barcode: body.barcode || body.sku || '',
      weight: parseFloat(body.weight) || 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
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
    
    products[index] = {
      ...products[index],
      sku: body.sku || products[index].sku,
      name: body.name || products[index].name,
      description: body.description || products[index].description,
      price: parseFloat(body.price) || products[index].price,
      stock: parseInt(body.stock) ?? products[index].stock,
      barcode: body.barcode || products[index].barcode,
      weight: parseFloat(body.weight) || products[index].weight,
      updatedAt: new Date().toISOString()
    };
    
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

  // ===== SCAN / PACKING ROUTES =====
  if (pathname === '/packing/scan') {
    return sendHTML(res, renderTemplate('packing_scan', { userName: session.name }));
  }

  if (pathname === '/api/scan' && method === 'POST') {
    const body = await parseBody(req);
    const barcode = body.barcode;
    const quantity = parseInt(body.quantity) || 1;
    const products = db.read('products');
    const product = products.find(p => p.barcode === barcode || p.sku === barcode);
    
    if (!product) {
      return sendJSON(res, { success: false, message: 'Produk tidak ditemukan dengan barcode: ' + barcode }, 404);
    }
    
    if (product.stock < quantity) {
      return sendJSON(res, { success: false, message: `Stok tidak cukup! Stok tersedia: ${product.stock}` }, 400);
    }
    
    // Kurangi stok
    const productIndex = products.findIndex(p => p.id === product.id);
    products[productIndex].stock -= quantity;
    products[productIndex].updatedAt = new Date().toISOString();
    db.write('products', products);
    
    // Catat scan history
    const scanHistory = db.read('scan_history');
    const scanRecord = {
      id: db.generateId(),
      productId: product.id,
      productName: product.name,
      sku: product.sku,
      barcode: barcode,
      quantity: quantity,
      stockBefore: product.stock,
      stockAfter: product.stock - quantity,
      scannedBy: session.username,
      scannedByName: session.name,
      scannedAt: new Date().toISOString()
    };
    scanHistory.push(scanRecord);
    db.write('scan_history', scanHistory);
    
    return sendJSON(res, { 
      success: true, 
      data: {
        product: products[productIndex],
        scan: scanRecord
      },
      message: `Berhasil scan keluar: ${product.name} (${quantity} pcs). Sisa stok: ${products[productIndex].stock}`
    });
  }

  // ===== ORDER / RESI ROUTES =====
  if (pathname === '/packing/resi') {
    return sendHTML(res, renderTemplate('cetak_resi', { userName: session.name }));
  }

  if (pathname === '/admin/resi' && session.role === 'admin') {
    return sendHTML(res, renderTemplate('cetak_resi', { userName: session.name }));
  }

  if (pathname === '/api/orders' && method === 'GET') {
    const orders = db.read('orders');
    return sendJSON(res, { success: true, data: orders });
  }

  if (pathname === '/api/orders' && method === 'POST') {
    const body = await parseBody(req);
    const orders = db.read('orders');
    
    const newOrder = {
      id: db.generateId(),
      orderNumber: body.orderNumber || '',
      resiNumber: body.resiNumber || '',
      buyerName: body.buyerName || '',
      buyerPhone: body.buyerPhone || '',
      buyerAddress: body.buyerAddress || '',
      buyerCity: body.buyerCity || '',
      buyerProvince: body.buyerProvince || '',
      buyerPostalCode: body.buyerPostalCode || '',
      courier: body.courier || 'J&T Express',
      productName: body.productName || '',
      quantity: parseInt(body.quantity) || 1,
      weight: parseFloat(body.weight) || 0.5,
      shopName: body.shopName || 'TikTok Shop',
      shopPhone: body.shopPhone || '',
      shopAddress: body.shopAddress || '',
      notes: body.notes || '',
      status: 'pending',
      createdBy: session.username,
      createdAt: new Date().toISOString()
    };
    
    orders.push(newOrder);
    db.write('orders', orders);
    return sendJSON(res, { success: true, data: newOrder });
  }

  if (pathname.startsWith('/api/orders/') && method === 'DELETE') {
    const orderId = pathname.split('/')[3];
    let orders = db.read('orders');
    orders = orders.filter(o => o.id !== orderId);
    db.write('orders', orders);
    return sendJSON(res, { success: true });
  }

  // ===== REPORTS API =====
  if (pathname === '/api/reports/daily' && method === 'GET') {
    const date = parsedUrl.query.date || new Date().toISOString().split('T')[0];
    const scanHistory = db.read('scan_history');
    const dailyScans = scanHistory.filter(s => s.scannedAt.startsWith(date));
    
    const summary = {
      date: date,
      totalScans: dailyScans.length,
      totalItemsOut: dailyScans.reduce((sum, s) => sum + s.quantity, 0),
      scans: dailyScans
    };
    
    return sendJSON(res, { success: true, data: summary });
  }

  if (pathname === '/api/reports/stock' && method === 'GET') {
    const products = db.read('products');
    return sendJSON(res, { success: true, data: products });
  }

  // ===== SCAN HISTORY =====
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
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
  console.log(`📦 Database path: ${DB_PATH}`);
  console.log(`👤 Default admin: admin / admin123`);
  console.log(`👤 Default packing: packing / packing123`);
});
