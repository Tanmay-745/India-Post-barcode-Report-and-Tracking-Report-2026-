import { useState, useEffect } from 'react';
import { DownloadCloud, Lock, User, Loader2, Info, AlertCircle, CheckCircle, Upload, FileText } from 'lucide-react';

function App() {
  const [formData, setFormData] = useState(() => {
    // Attempt to load from localStorage, otherwise use defaults
    const saved = localStorage.getItem('indiaPost_creds');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        console.error("Failed to parse saved credentials", e);
      }
    }
    return {
      username: '3000063045',
      password: 'Dop@1234'
    };
  });

  const [savedStatus, setSavedStatus] = useState(false);

  // Save to localStorage whenever formData changes
  useEffect(() => {
    localStorage.setItem('indiaPost_creds', JSON.stringify(formData));
    setSavedStatus(true);
    const timer = setTimeout(() => setSavedStatus(false), 2000);
    return () => clearTimeout(timer);
  }, [formData]);
  
  const [status, setStatus] = useState({ state: 'idle', message: '' }); // idle, loading, success, error
  const [barcodeFile, setBarcodeFile] = useState(null);

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      setBarcodeFile(file);
      setStatus({ state: 'idle', message: `Selected file: ${file.name}` });
    }
  };
  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleFetchReceipts = async (e) => {
    e.preventDefault();
    await runScraper('http://localhost:3001/api/scrape', 'IndiaPost_Receipts');
  };

  const handleFetchArticles = async (e) => {
    e.preventDefault();
    await runScraper('http://localhost:3001/api/scrape-articles', 'IndiaPost_Articles');
  };

  const runScraper = async (url, filenamePrefix) => {
    // Basic validation
    if (!formData.username || !formData.password) {
      setStatus({ state: 'error', message: 'Please fill all required fields.' });
      return;
    }

    setStatus({ 
      state: 'loading', 
      message: 'Processing... Please check the opened browser window to solve the CAPTCHA.' 
    });

    try {
      let response;
      if (barcodeFile) {
        // Use FormData for file upload
        const formDataPayload = new FormData();
        formDataPayload.append('username', formData.username);
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
          body: JSON.stringify(formData)
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
      setBarcodeFile(null); // Reset after success
    } catch (error) {
      console.error("Operation failed:", error);
      setStatus({ state: 'error', message: error.message });
    }
  };

  return (
    <>
      <div className="bg-shape shape-1"></div>
      <div className="bg-shape shape-2"></div>
      
      <div className="app-container">
        <div className="glass-panel">
          <div className="header">
            <div className="header-icon">
              <DownloadCloud color="white" size={32} />
            </div>
            <h1>India Post Extractor</h1>
            <p>Automate your receipt bulk downloads</p>
          </div>

          <form onSubmit={handleFetchReceipts}>
            <div className="form-grid">
              <div className="form-group full-width">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label><User size={16}/> Customer Username</label>
                  {savedStatus && <span style={{ fontSize: '12px', color: '#10b981', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <CheckCircle size={14}/> Saved to browser
                  </span>}
                </div>
                <input 
                  type="text" 
                  name="username" 
                  placeholder="Enter portal username" 
                  value={formData.username}
                  onChange={handleInputChange}
                  required
                />
              </div>

              <div className="form-group full-width">
                <label><Lock size={16}/> Portal Password</label>
                <input 
                  type="password" 
                  name="password" 
                  placeholder="Enter portal password" 
                  value={formData.password}
                  onChange={handleInputChange}
                  required
                />
              </div>
              <div className="form-group full-width">
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#a5b4fc', cursor: 'pointer', background: 'rgba(255,255,255,0.05)', padding: '12px', borderRadius: '8px', border: '1px dashed rgba(165, 180, 252, 0.3)' }}>
                  <Upload size={20}/> 
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: '500' }}>{barcodeFile ? barcodeFile.name : 'Upload Barcode List'}</div>
                    <div style={{ fontSize: '11px', opacity: 0.7 }}>CSV or Excel containing barcode column</div>
                  </div>
                  <input 
                    type="file" 
                    accept=".csv, .xlsx, .xls"
                    onChange={handleFileChange}
                    style={{ display: 'none' }}
                  />
                </label>
              </div>
            </div>

            <div className="button-group">
              <button 
                type="button" 
                className="btn-submit" 
                onClick={handleFetchReceipts}
                disabled={status.state === 'loading'}
              >
                {status.state === 'loading' ? (
                  <>
                    <Loader2 className="spinner" size={20} />
                    Processing...
                  </>
                ) : (
                  <>
                    <DownloadCloud size={20} />
                    Fetch Bulk Receipts
                  </>
                )}
              </button>

              <button 
                type="button" 
                className="btn-submit secondary" 
                onClick={handleFetchArticles}
                disabled={status.state === 'loading'}
              >
                {status.state === 'loading' ? (
                  <>
                    <Loader2 className="spinner" size={20} />
                    Processing...
                  </>
                ) : (
                  <>
                    <Info size={20} />
                    Track Bulk Articles
                  </>
                )}
              </button>
            </div>
          </form>

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
        </div>
      </div>
    </>
  );
}

export default App;
