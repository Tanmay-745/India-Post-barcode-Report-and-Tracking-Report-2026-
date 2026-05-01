import { useState, useEffect, useRef } from 'react';
import {
  AlertCircle,
  CheckCircle,
  DownloadCloud,
  FileSpreadsheet,
  FileText,
  Info,
  Loader2,
  Lock,
  PackageCheck,
  ShieldCheck,
  Sparkles,
  Upload,
  User,
} from 'lucide-react';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:3001';

function App() {
  const [formData, setFormData] = useState(() => {
    const saved = localStorage.getItem('indiaPost_creds');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return {
          username: parsed.username || '',
          password: '',
          rememberUsername: Boolean(parsed.username),
        };
      } catch (e) {
        console.error('Failed to parse saved credentials', e);
      }
    }
    return {
      username: '',
      password: '',
      rememberUsername: false,
    };
  });

  const [savedStatus, setSavedStatus] = useState(false);
  const [status, setStatus] = useState({ state: 'idle', message: '' }); // idle, loading, success, error
  const [barcodeFile, setBarcodeFile] = useState(null);
  const [activeAction, setActiveAction] = useState(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (formData.rememberUsername && formData.username) {
      localStorage.setItem('indiaPost_creds', JSON.stringify({ username: formData.username }));
      setSavedStatus(true);
      const timer = setTimeout(() => setSavedStatus(false), 1800);
      return () => clearTimeout(timer);
    }

    localStorage.removeItem('indiaPost_creds');
    setSavedStatus(false);
    return undefined;
  }, [formData.rememberUsername, formData.username]);

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      setBarcodeFile(file);
      setStatus({ state: 'idle', message: `Selected file: ${file.name}` });
    }
  };
  const handleInputChange = (e) => {
    const { name, value, checked, type } = e.target;
    setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  const handleFetchReceipts = async (e) => {
    e.preventDefault();
    await runScraper(`${API_BASE_URL}/api/scrape`, 'IndiaPost_Receipts', 'receipts');
  };

  const handleFetchArticles = async (e) => {
    e.preventDefault();
    await runScraper(`${API_BASE_URL}/api/scrape-articles`, 'IndiaPost_Articles', 'articles');
  };

  const clearSelectedFile = () => {
    setBarcodeFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    setStatus({ state: 'idle', message: 'Barcode filter removed. The next run will process all available records.' });
  };

  const runScraper = async (url, filenamePrefix, actionName) => {
    if (!formData.username || !formData.password) {
      setStatus({ state: 'error', message: 'Please fill all required fields.' });
      return;
    }

    setActiveAction(actionName);
    setStatus({ 
      state: 'loading', 
      message: 'Processing... Keep this portal tab open, and use the opened browser window to solve the CAPTCHA.' 
    });

    try {
      let response;
      if (barcodeFile) {
        // Use FormData for file upload
        const formDataPayload = new FormData();
        formDataPayload.append('username', formData.username.trim());
        formDataPayload.append('password', formData.password);
        formDataPayload.append('barcodeFile', barcodeFile);
        
        response = await fetch(url, {
          method: 'POST',
          body: formDataPayload
        });
      } else {
        // Use JSON for regular request
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: formData.username.trim(),
            password: formData.password,
          })
        });
      }

      if (!response.ok) {
        let errorMessage = 'Automation failed';
        try {
          const errData = await response.json();
          errorMessage = errData.error || errorMessage;
        } catch (e) {
            errorMessage = `Server Error (${response.status})`;
        }
        throw new Error(errorMessage);
      }

      // Handle the zip file download
      const blob = await response.blob();
      const urlBlob = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = urlBlob;
      a.download = `${filenamePrefix}_${new Date().getTime()}.zip`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(urlBlob);
      a.remove();

      setStatus({ state: 'success', message: 'Bulk download complete! Check your downloads folder.' });
      setBarcodeFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    } catch (error) {
      console.error('Operation failed:', error);
      setStatus({
        state: 'error',
        message: error.message === 'Failed to fetch'
          ? 'Could not reach the backend. Start the backend server on port 3001 and try again.'
          : error.message,
      });
    } finally {
      setActiveAction(null);
    }
  };

  const isLoading = status.state === 'loading';
  const selectedFileLabel = barcodeFile ? `${barcodeFile.name} selected` : 'CSV, XLS, or XLSX barcode filter';

  return (
    <main className="app-shell">
      <section className="hero-band">
        <div className="hero-content">
          <div className="eyebrow"><ShieldCheck size={16} /> Secure automation console</div>
          <h1>India Post Bulk Desk</h1>
          <p>Download receipts and article tracking PDFs from one focused workspace.</p>

          <div className="hero-metrics" aria-label="Workflow highlights">
            <div>
              <span>01</span>
              Login
            </div>
            <div>
              <span>02</span>
              Filter
            </div>
            <div>
              <span>03</span>
              Export ZIP
            </div>
          </div>
        </div>

        <div className="hero-visual" aria-hidden="true">
          <div className="stamp-card">
            <PackageCheck size={34} />
            <span>ZIP export ready</span>
          </div>
          <div className="track-card">
            <FileText size={28} />
            <span>Receipts and tracking PDFs</span>
          </div>
        </div>
      </section>

      <section className="workspace">
        <form className="control-panel" onSubmit={handleFetchReceipts}>
          <div className="panel-header">
            <div>
              <p className="section-kicker">Portal access</p>
              <h2>Run a bulk job</h2>
            </div>
            <div className="status-pill">
              <Sparkles size={15} />
              Browser assisted
            </div>
          </div>

          <div className="form-grid">
            <div className="form-group">
              <div className="label-row">
                <label htmlFor="username"><User size={16}/> Customer username</label>
                {savedStatus && (
                  <span className="saved-badge"><CheckCircle size={14}/> Saved</span>
                )}
              </div>
              <input
                id="username"
                type="text"
                name="username"
                placeholder="Enter portal username"
                value={formData.username}
                onChange={handleInputChange}
                autoComplete="username"
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="password"><Lock size={16}/> Portal password</label>
              <input
                id="password"
                type="password"
                name="password"
                placeholder="Enter portal password"
                value={formData.password}
                onChange={handleInputChange}
                autoComplete="current-password"
                required
              />
            </div>

            <label className="remember-row">
              <input
                type="checkbox"
                name="rememberUsername"
                checked={formData.rememberUsername}
                onChange={handleInputChange}
              />
              Remember username on this browser
            </label>

            <div className="upload-zone">
              <label htmlFor="barcodeFile">
                <span className="upload-icon"><Upload size={22}/></span>
                <span>
                  <strong>{barcodeFile ? barcodeFile.name : 'Upload barcode list'}</strong>
                  <small>{selectedFileLabel}</small>
                </span>
                <input
                  ref={fileInputRef}
                  id="barcodeFile"
                  type="file"
                  accept=".csv, .xlsx, .xls"
                  onChange={handleFileChange}
                />
              </label>
              {barcodeFile && (
                <button className="text-button" type="button" onClick={clearSelectedFile}>
                  Remove file
                </button>
              )}
            </div>
          </div>

          <div className="action-grid">
            <button
              type="button"
              className="action-button primary"
              onClick={handleFetchReceipts}
              disabled={isLoading}
            >
              {activeAction === 'receipts' ? <Loader2 className="spinner" size={20} /> : <DownloadCloud size={20} />}
              <span>
                <strong>{activeAction === 'receipts' ? 'Fetching receipts...' : 'Fetch bulk receipts'}</strong>
                <small>Generate receipt PDFs and ZIP</small>
              </span>
            </button>

            <button
              type="button"
              className="action-button secondary"
              onClick={handleFetchArticles}
              disabled={isLoading}
            >
              {activeAction === 'articles' ? <Loader2 className="spinner" size={20} /> : <FileSpreadsheet size={20} />}
              <span>
                <strong>{activeAction === 'articles' ? 'Tracking articles...' : 'Track bulk articles'}</strong>
                <small>Export article tracking PDFs</small>
              </span>
            </button>
          </div>

          {status.message && (
            <div className={`status-message ${
              status.state === 'loading' ? 'info' : 
              status.state === 'error' ? 'error' : 'success'
            }`}>
              {status.state === 'loading' && <Info size={18} />}
              {status.state === 'error' && <AlertCircle size={18} />}
              {status.state === 'success' && <CheckCircle size={18} />}
              <span>{status.message}</span>
            </div>
          )}
        </form>

        <aside className="insight-panel">
          <div className="insight-block">
            <p className="section-kicker">What happens next</p>
            <h2>Guided browser run</h2>
            <p>The backend opens Chrome, fills the login details you enter, then waits while you solve CAPTCHA and choose filters.</p>
          </div>

          <div className="timeline">
            <div>
              <span>1</span>
              <p>Start the receipt or article job from this page.</p>
            </div>
            <div>
              <span>2</span>
              <p>Complete CAPTCHA and any India Post filters in Chrome.</p>
            </div>
            <div>
              <span>3</span>
              <p>Receive a ZIP file with PDFs and an execution report.</p>
            </div>
          </div>

          <div className="format-strip">
            <span>CSV</span>
            <span>XLS</span>
            <span>XLSX</span>
          </div>
        </aside>
      </section>
    </main>
  );
}

export default App;
