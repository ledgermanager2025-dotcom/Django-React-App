import React, { useState, useEffect, useMemo, useCallback } from 'react';

// --- API and Auth Configuration ---
const API_BASE_URL = 'http://localhost:8000/api'; // Define your Django API root URL
const LOGIN_ENDPOINT = `${API_BASE_URL}/token/`;
const REFRESH_ENDPOINT = `${API_BASE_URL}/token/refresh/`;

// --- Utility Functions for JWT ---

const setTokens = (tokens) => {
    if (tokens.access) {
        localStorage.setItem('access_token', tokens.access);
    }
    if (tokens.refresh) {
        localStorage.setItem('refresh_token', tokens.refresh);
    }
};

const getTokens = () => ({
    access: localStorage.getItem('access_token'),
    refresh: localStorage.getItem('refresh_token'),
});

const clearTokens = () => {
    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
};


/** * Authenticated Fetch Wrapper: Attaches Authorization header and handles 401 errors.
 * Note: This simplified version does NOT implement automatic token refresh. 
 * If the access token expires, it forces a logout and the user must log back in.
 */
const authFetch = async (endpoint, options = {}) => {
    const tokens = getTokens();
    
    if (!tokens.access) {
        // This should not happen if called after isAuthenticated check, but a safety
        throw new Error('No access token found. Please log in.');
    }

    const headers = {
        'Authorization': `Bearer ${tokens.access}`,
        'Content-Type': 'application/json',
        ...options.headers,
    };

    const response = await fetch(endpoint, {
        ...options,
        headers: headers,
    });
    
    // --- Token Refresh Logic (Simplified Error Handling) ---
    if (response.status === 401) {
        // If a 401 occurs, it usually means the token is expired or invalid.
        // In a real app, you would attempt a silent refresh here. 
        // For this single-file example, we force a logout.
        console.error("401 Unauthorized: Access token invalid or expired. Logging out.");
        clearTokens();
        
        // Throw an error that the calling function can catch to trigger app-level state change (logout)
        throw new Error('Unauthorized or expired token. Session ended.');
    }

    return response;
};

/** Helper to fetch data from the API and handle errors */
const fetchData = async (endpoint) => {
    try {
        const response = await authFetch(`${API_BASE_URL}/${endpoint}/`);
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP error! status: ${response.status} - ${errorText.substring(0, 100)}...`);
        }
        const data = await response.json();
        
        return data.map(item => ({
            ...item,
            // Use 'timestamp' for transactions/expenses, as per Django model output
            timestamp: { 
                toDate: () => new Date(item.timestamp || item.date || null) 
            } 
        }));
    } catch (error) {
        // Re-throw if it's the specific unauthorized error to trigger app-level logout
        if (error.message.includes('Unauthorized or expired token')) {
             throw error; 
        }
        console.error(`Fetch error for ${endpoint}:`, error);
        return [];
    }
};

/** Helper to post data to the API and handle errors */
const postData = async (endpoint, payload) => {
    try {
        const response = await authFetch(`${API_BASE_URL}/${endpoint}/`, {
            method: 'POST',
            body: JSON.stringify(payload),
        });
        if (!response.ok) {
            const errorData = await response.json();
            const firstError = Object.entries(errorData)[0] || ['Error', 'Check inputs'];
            throw new Error(`API Error: ${response.status} - ${firstError[0]}: ${JSON.stringify(firstError[1])}`);
        }
        return await response.json();
    } catch (error) {
        if (error.message.includes('Unauthorized or expired token')) {
             throw error; 
        }
        console.error(`POST error for ${endpoint}:`, error);
        throw error;
    }
};

/** Helper to delete data from the API and handle errors */
const deleteData = async (endpoint, id) => {
    try {
        const response = await authFetch(`${API_BASE_URL}/${endpoint}/${id}/`, {
            method: 'DELETE',
        });
        if (response.status === 204 || response.ok) { // 204 No Content is standard for successful DELETE
            return true;
        }
        const errorText = await response.text();
        throw new Error(`Deletion HTTP error! status: ${response.status} - ${errorText || 'Unknown Error'}`);
    } catch (error) {
        if (error.message.includes('Unauthorized or expired token')) {
             throw error; 
        }
        console.error(`DELETE error for ${endpoint}/${id}:`, error);
        throw error;
    }
};


// --- Reusable UI Components ---

/** A simple, reusable Modal component. */
const Modal = ({ title, children, isOpen, onClose }) => {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 modal-overlay bg-black bg-opacity-50" onClick={onClose}>
            <div className="bg-white w-full max-w-lg p-6 rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
                <h2 className="text-2xl font-semibold mb-4 text-gray-800 border-b pb-2">{title}</h2>
                {children}
                <div className="flex justify-end mt-6 space-x-3">
                    <button 
                        onClick={onClose} 
                        className="text-sm text-gray-700 bg-gray-200 px-4 py-2 rounded-md hover:bg-gray-300 transition"
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
};

/** A reusable card for displaying metrics. */
const MetricCard = ({ title, value, valueColorClass = 'text-gray-900', prefix = '₹', icon, isLarge = false, onClick = null }) => (
    <div 
        className={`bg-white p-4 rounded-xl shadow-md flex ${isLarge ? 'flex-row items-center justify-between' : 'flex-col'} ${onClick ? 'cursor-pointer hover:shadow-lg transition' : ''}`}
        onClick={onClick}
    >
        <div className={`flex items-center ${isLarge ? '' : 'mb-2'}`}>
            {icon && <span className={`text-3xl mr-3 ${isLarge ? 'text-4xl text-indigo-600' : 'text-xl text-gray-600'}`}>{icon}</span>}
            <p className={`text-xs font-medium text-gray-500 uppercase ${isLarge ? 'text-lg' : ''}`}>{title}</p>
        </div>
        <p className={`${isLarge ? 'text-3xl' : 'text-2xl'} font-bold mt-1 ${valueColorClass}`}>{prefix}{value}</p>
    </div>
);


// --- Authentication Component ---

const LoginPage = ({ onLoginSuccess, setError }) => {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);

    const handleLogin = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            const response = await fetch(LOGIN_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });

            if (!response.ok) {
                const errorData = await response.json();
                const detail = errorData.detail || 'Invalid Credentials';
                throw new Error(`Login failed: ${detail}`);
            }

            const tokens = await response.json();
            setTokens(tokens); // Store tokens in localStorage
            
            // Assume the user is successfully logged in if tokens are received
            onLoginSuccess({ username }); 

        } catch (error) {
            setError(error.message || 'An unknown error occurred during login.');
            clearTokens(); // Ensure no partial tokens are stored
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center bg-gray-100 p-4">
            <div className="bg-white p-8 rounded-xl shadow-2xl w-full max-w-sm">
                <h2 className="text-3xl font-bold text-center text-indigo-600 mb-6">Ledger Login</h2>
                <p className="text-center text-sm text-gray-500 mb-6">Sign in to access your financial records.</p>
                <form onSubmit={handleLogin} className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700">Username</label>
                        <input
                            type="text"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            required
                            placeholder="Enter username"
                            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-3 border focus:ring-indigo-500 focus:border-indigo-500"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700">Password</label>
                        <input
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                            placeholder="Enter password"
                            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-3 border focus:ring-indigo-500 focus:border-indigo-500"
                        />
                    </div>
                    <button 
                        type="submit" 
                        disabled={loading}
                        className="w-full bg-indigo-600 text-white font-medium py-3 rounded-lg hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed shadow-lg"
                    >
                        {loading ? 'Logging In...' : 'Log In'}
                    </button>
                </form>
            </div>
        </div>
    );
};


// --- Main App Component ---

const App = () => {
    // 1. Auth State
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [user, setUser] = useState(null);
    
    // 2. Core Data States
    const [materials, setMaterials] = useState([]);
    const [customers, setCustomers] = useState([]);
    const [history, setHistory] = useState([]); // Transactions
    const [operatingExpenses, setOperatingExpenses] = useState([]); 

    // 3. UI States
    const [currentView, setCurrentView] = useState('dashboard');
    const [modal, setModal] = useState({ 
        customerHistory: false, customerPnl: false, 
        addCredit: false, addDebit: false, 
        addExpense: false, addCR: false, 
        addMaterial: false, addCustomer: false,
    });
    const [transactionData, setTransactionData] = useState({}); 
    const [error, setError] = useState(''); 
    const [loading, setLoading] = useState(true);
    const [refetchKey, setRefetchKey] = useState(0); 
    const [confirmDelete, setConfirmDelete] = useState({ 
        isOpen: false, 
        id: null, 
        endpoint: '', 
        name: '' 
    });

    // --- Authentication Handlers ---
    const handleLoginSuccess = useCallback((userData) => {
        setIsAuthenticated(true);
        setUser(userData);
        setLoading(false);
        setRefetchKey(prev => prev + 1); // Trigger data load after login
    }, []);

    const handleLogout = useCallback(() => {
        clearTokens();
        setIsAuthenticated(false);
        setUser(null);
        // Clear all sensitive data when logging out
        setMaterials([]);
        setCustomers([]);
        setHistory([]);
        setOperatingExpenses([]);
        setLoading(false); 
        setError('');
    }, []);

    // Initial Auth Check on load
    useEffect(() => {
        const tokens = getTokens();
        if (tokens.access) {
            // Assume valid token for now; a 401 on first fetch will log them out
            setIsAuthenticated(true);
            setUser({ username: 'Authenticated User' }); // Placeholder user info
            setLoading(false);
            setRefetchKey(prev => prev + 1); // Trigger data fetch
        } else {
            setLoading(false);
        }
    }, []);


    // --- Data Fetching Effect ---
    const refetchData = useCallback(() => {
        // Only trigger refetch if authenticated
        if (isAuthenticated) {
            setRefetchKey(prev => prev + 1);
        }
    }, [isAuthenticated]);

    useEffect(() => {
        if (!isAuthenticated) {
            setLoading(false);
            return;
        }

        const loadData = async () => {
            setLoading(true);
            setError('');
            try {
                const [mats, custs, trans, exps] = await Promise.all([
                    fetchData('materials'),
                    fetchData('customers'),
                    fetchData('transactions'),
                    fetchData('expenses')
                ]);

                setMaterials(mats);
                setCustomers(custs);
                setHistory(trans);
                setOperatingExpenses(exps);
                
            } catch (err) {
                // Check if the error is due to session ending
                if (err.message.includes('Unauthorized or expired token')) {
                    handleLogout();
                    setError('Session expired. Please log in again.');
                } else {
                    setError(err.message || 'Failed to load data. Check network/backend.');
                }
            } finally {
                setLoading(false);
            }
        };

        loadData();
    }, [refetchKey, isAuthenticated, handleLogout]); // Dependency on isAuthenticated and handleLogout is critical


    // --- Data Lookups & Calculation Helpers ---
    // (Omitted for brevity - same as before)

    const getMaterialName = useCallback((id) => materials.find(m => m.id === id)?.name || 'N/A', [materials]);
    const getCustomerName = useCallback((id) => customers.find(c => c.id === id)?.name || 'N/A', [customers]);

    // WAC and Stock Calculation 
    const materialWACData = useMemo(() => {
        return materials.reduce((acc, m) => {
            const materialCredits = history.filter(t => t.transaction_type === 'CR' && t.material === m.id);
            const totalCostOfPurchases = materialCredits.reduce((sum, t) => sum + parseFloat(t.total_price || 0), 0);
            const totalQuantityPurchased = materialCredits.reduce((sum, t) => sum + parseFloat(t.quantity || 0), 0);
            
            const wac = totalQuantityPurchased > 0 ? totalCostOfPurchases / totalQuantityPurchased : 0;
            
            const totalDebit = history
                .filter(t => t.transaction_type === 'DB' && t.material === m.id)
                .reduce((sum, t) => sum + parseFloat(t.quantity || 0), 0);

            const currentQuantity = totalQuantityPurchased - totalDebit;

            acc[m.id] = {
                ...m,
                wac,
                currentQuantity,
                stockValue: currentQuantity > 0 ? currentQuantity * wac : 0
            };
            return acc;
        }, {});
    }, [materials, history]);

    // Customer Financials (Helper)
    const getCustomerFinancials = useCallback((customerId) => {
        const customerTransactions = history.filter(t => t.customer === customerId);

        const salesTransactions = customerTransactions.filter(t => t.transaction_type === 'DB');
        const crTransactions = customerTransactions.filter(t => t.transaction_type === 'RC');

        const totalRevenue = salesTransactions
            .reduce((sum, t) => sum + parseFloat(t.total_price || 0), 0);

        const moneyReceivedFromSales = salesTransactions
            .reduce((sum, t) => sum + parseFloat(t.money_received || 0), 0);

        const crReceived = crTransactions
            .reduce((sum, t) => sum + parseFloat(t.total_price || 0), 0);

        const totalMoneyReceived = moneyReceivedFromSales + crReceived;
        const borrowings = totalRevenue - totalMoneyReceived;
        
        let totalCOGS = 0;
        salesTransactions.forEach(t => {
            const materialData = materialWACData[t.material];
            if (materialData) {
                totalCOGS += parseFloat(t.quantity || 0) * materialData.wac;
            }
        });
        
        const grossProfit = totalRevenue - totalCOGS;

        return { 
            sellValue: totalRevenue, 
            actualValue: totalMoneyReceived, 
            borrowings, 
            totalCOGS, 
            grossProfit, 
            transactions: customerTransactions 
        };
    }, [history, materialWACData]);


    // Dashboard Metrics Calculation 
    const dashboardMetrics = useMemo(() => {
        const metrics = history.reduce((acc, t) => {
            if (t.transaction_type === 'DB') {
                acc.totalRevenue += parseFloat(t.total_price || 0);
                acc.moneyReceived += parseFloat(t.money_received || 0);
                
                const materialData = materialWACData[t.material];
                if (materialData) {
                    acc.totalCOGS += parseFloat(t.quantity || 0) * materialData.wac;
                }
            } else if (t.transaction_type === 'RC') {
                acc.moneyReceived += parseFloat(t.total_price || 0); 
            }
            return acc;
        }, { totalRevenue: 0, moneyReceived: 0, totalCOGS: 0 });

        
        const trueOperatingExpenses = operatingExpenses.filter(e => 
            e.description && e.description.toLowerCase().trim() !== 'cash'
        );
        
        const totalCashWithdrawal = operatingExpenses
            .filter(e => e.description && e.description.toLowerCase().trim() === 'cash')
            .reduce((sum, e) => sum + parseFloat(e.amount || 0), 0);
        
        const totalCurrentStockValue = Object.values(materialWACData).reduce((sum, m) => sum + m.stockValue, 0);
        const totalSellValue = history
            .filter(t => t.transaction_type === 'DB')
            .reduce((sum, t) => sum + parseFloat(t.total_price || 0), 0);
        const totalMoneyReceived = metrics.moneyReceived;

        metrics.borrowings = totalSellValue - totalMoneyReceived;
        metrics.totalCurrentStockValue = totalCurrentStockValue;
        
        metrics.totalOperatingExpenses = trueOperatingExpenses.reduce((sum, e) => sum + parseFloat(e.amount || 0), 0); 

        metrics.netProfit = metrics.totalRevenue - metrics.totalCOGS - metrics.totalOperatingExpenses; 
        
        metrics.totalCashWithdrawal = totalCashWithdrawal;
        
        metrics.adjustedNetProfit = metrics.netProfit - metrics.totalCashWithdrawal;
        
        return metrics;
    }, [history, materialWACData, operatingExpenses]); 

    // --- Modal Handlers ---
    const openModal = useCallback((name, data = {}) => {
        setError('');
        setTransactionData(data);
        setModal(prev => ({ ...prev, [name]: true }));
    }, []);

    const closeModal = useCallback((name) => {
        setModal(prev => ({ ...prev, [name]: false }));
        setError('');
    }, []);

    // --- Form Submission Logic (APIs) ---

    const handleFormSubmit = async (endpoint, payload, modalName) => {
        setError('');
        try {
            await postData(endpoint, payload);
            refetchData(); // Trigger full data refresh
            closeModal(modalName);
        } catch (err) {
            // Catch the unauthorized error and handle logout
            if (err.message.includes('Unauthorized or expired token')) {
                handleLogout();
                setError('Session expired during submission. Please log in again.');
            } else {
                setError(err.message || 'An unknown error occurred during submission.');
            }
        }
    };
    
    // --- Deletion Logic ---

    const triggerDelete = useCallback((id, endpoint, name) => {
        setConfirmDelete({
            isOpen: true,
            id,
            endpoint,
            name
        });
    }, []);

    // --- TOP-LEVEL MODAL COMPONENTS ---

    const ModalForm = ({ title, isOpen, onClose, children }) => (
        <Modal title={title} isOpen={isOpen} onClose={onClose}>
            <div className="space-y-4">
                {children}
            </div>
        </Modal>
    );
    
    /** Confirmation Modal for Deletion */
    const ConfirmationModal = () => {
        const { isOpen, id, endpoint, name } = confirmDelete;

        const handleConfirm = async () => {
            setError('');
            try {
                await deleteData(endpoint, id);
                refetchData(); // Refresh data after successful deletion
            } catch (err) {
                if (err.message.includes('Unauthorized or expired token')) {
                    handleLogout();
                    setError('Session expired during deletion. Please log in again.');
                } else {
                    setError(err.message || 'An unknown error occurred during deletion.');
                }
            } finally {
                setConfirmDelete({ isOpen: false, id: null, endpoint: '', name: '' });
            }
        };
        
        const handleClose = () => {
            setConfirmDelete({ isOpen: false, id: null, endpoint: '', name: '' });
        };

        return (
            <Modal 
                title="Confirm Deletion" 
                isOpen={isOpen} 
                onClose={handleClose}
            >
                <p className="text-gray-700">
                    Are you sure you want to delete the entry: <span className="font-semibold text-red-600">"{name}"</span>? 
                    This action cannot be undone.
                </p>
                <div className="flex justify-end mt-6 space-x-3">
                    <button 
                        onClick={handleClose} 
                        className="text-sm text-gray-700 bg-gray-200 px-4 py-2 rounded-md hover:bg-gray-300 transition"
                    >
                        Cancel
                    </button>
                    <button 
                        onClick={handleConfirm} 
                        className="text-sm bg-red-600 text-white px-4 py-2 rounded-md hover:bg-red-700 transition font-medium"
                    >
                        Yes, Delete
                    </button>
                </div>
            </Modal>
        );
    };

    // --- Data Entry Modals (Omitted implementations for brevity, they remain identical but use the authenticated postData via handleFormSubmit) ---

    // 1. Add New Customer Modal
    const AddCustomerModal = () => {
        const [name, setName] = useState('');
        const handleSubmit = (e) => {
            e.preventDefault();
            handleFormSubmit('customers', { name }, 'addCustomer');
            setName('');
        };
        return (
            <ModalForm title="Add New Customer" isOpen={modal.addCustomer} onClose={() => closeModal('addCustomer')}>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div><label className="block text-sm font-medium text-gray-700">Customer Name</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} required className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2 border"/></div>
                    <button type="submit" className="w-full bg-indigo-600 text-white font-medium py-2 rounded-lg hover:bg-indigo-700 transition">Add Customer</button>
                </form>
            </ModalForm>
        );
    };

    // 2. Add Sale (Debit) Modal
    const AddDebitModal = () => {
        const [customerId, setCustomerId] = useState('');
        const [materialId, setMaterialId] = useState('');
        const [quantity, setQuantity] = useState('');
        const [totalPrice, setTotalPrice] = useState('');
        const [moneyReceived, setMoneyReceived] = useState('');

        const handleSubmit = (e) => {
            e.preventDefault();
            const soldQuantity = parseFloat(quantity);
            const selectedMaterialId = parseInt(materialId);
            const selectedMaterial = materialWACData[selectedMaterialId];
            
            if (isNaN(soldQuantity) || soldQuantity <= 0) { return setError('Please enter a valid sale quantity.'); }
            if (!selectedMaterial) { return setError('Please select a material.'); }
            if (selectedMaterial.currentQuantity < soldQuantity) {
                return setError(`Insufficient stock for ${selectedMaterial.name}. Available: ${selectedMaterial.currentQuantity.toFixed(2)} units.`);
            }

            const payload = {
                transaction_type: 'DB', customer: parseInt(customerId), material: selectedMaterialId,
                quantity: soldQuantity, total_price: parseFloat(totalPrice), money_received: parseFloat(moneyReceived),
            };
            handleFormSubmit('transactions', payload, 'addDebit');
        };

        const materialStockInfo = useMemo(() => {
            if (!materialId) return '';
            const material = materialWACData[parseInt(materialId)];
            if (!material) return '';
            const stock = material.currentQuantity;
            const stockClass = stock <= 0 ? 'text-red-500 font-bold' : 'text-green-600 font-bold';
            return (<p className="text-sm mt-1">Available Stock: <span className={stockClass}>{stock.toFixed(2)} units</span></p>);
        }, [materialId, materialWACData]);

        return (
            <ModalForm title="Record Sale (Debit)" isOpen={modal.addDebit} onClose={() => closeModal('addDebit')}>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} required className="w-full p-2 border rounded-md"><option value="">Select Customer</option>{customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                    <div><select value={materialId} onChange={(e) => setMaterialId(e.target.value)} required className="w-full p-2 border rounded-md"><option value="">Select Material</option>{materials.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select>{materialStockInfo}</div>
                    <input type="number" step="0.01" placeholder="Quantity Sold" value={quantity} onChange={(e) => setQuantity(e.target.value)} required className="w-full p-2 border rounded-md" />
                    <input type="number" step="0.01" placeholder="Total Sale Price (₹)" value={totalPrice} onChange={(e) => setTotalPrice(e.target.value)} required className="w-full p-2 border rounded-md" />
                    <input type="number" step="0.01" placeholder="Money Received Now (₹)" value={moneyReceived} onChange={(e) => setMoneyReceived(e.target.value)} required className="w-full p-2 border rounded-md" />
                    <button type="submit" className="w-full bg-red-600 text-white font-medium py-2 rounded-lg hover:bg-red-700 transition">Record Sale</button>
                </form>
            </ModalForm>
        );
    };

    // 3. Add Purchase (Credit) Modal
    const AddCreditModal = () => {
        const [materialId, setMaterialId] = useState('');
        const [quantity, setQuantity] = useState('');
        const [totalPrice, setTotalPrice] = useState('');

        const handleSubmit = (e) => {
            e.preventDefault();
            const payload = {
                transaction_type: 'CR', material: parseInt(materialId),
                quantity: parseFloat(quantity), total_price: parseFloat(totalPrice),
            };
            handleFormSubmit('transactions', payload, 'addCredit');
        };

        return (
            <ModalForm title="Record Purchase (Credit)" isOpen={modal.addCredit} onClose={() => closeModal('addCredit')}>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <select value={materialId} onChange={(e) => setMaterialId(e.target.value)} required className="w-full p-2 border rounded-md"><option value="">Select Material</option>{materials.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
                    <input type="number" step="0.01" placeholder="Quantity Purchased" value={quantity} onChange={(e) => setQuantity(e.target.value)} required className="w-full p-2 border rounded-md" />
                    <input type="number" step="0.01" placeholder="Total Purchase Cost (₹)" value={totalPrice} onChange={(e) => setTotalPrice(e.target.value)} required className="w-full p-2 border rounded-md" />
                    <button type="submit" className="w-full bg-green-600 text-white font-medium py-2 rounded-lg hover:bg-green-700 transition">Record Purchase</button>
                </form>
            </ModalForm>
        );
    };
    
    // 4. Add New Material Modal
    const AddMaterialModal = () => {
        const [name, setName] = useState('');
        const [color, setColor] = useState('');
        const handleSubmit = (e) => {
            e.preventDefault();
            const payload = { name, color: color || null };
            handleFormSubmit('materials', payload, 'addMaterial');
            setName(''); setColor('');
        };
        return (
            <ModalForm title="Add New Material" isOpen={modal.addMaterial} onClose={() => closeModal('addMaterial')}>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div><label className="block text-sm font-medium text-gray-700">Material Name</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} required className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2 border"/></div>
                    <div><label className="block text-sm font-medium text-gray-700">Color/Description (Optional)</label><input type="text" value={color} onChange={(e) => setColor(e.target.value)} className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2 border"/></div>
                    <button type="submit" className="w-full bg-indigo-600 text-white font-medium py-2 rounded-lg hover:bg-indigo-700 transition">Add Material</button>
                </form>
            </ModalForm>
        );
    };
    
    // 5. Add Customer Payment (CR) Modal
    const AddCRModal = () => {
        const [customerId, setCustomerId] = useState('');
        const [amount, setAmount] = useState('');
        const [description, setDescription] = useState('');

        const handleSubmit = (e) => {
            e.preventDefault();
            const payload = {
                transaction_type: 'RC', customer: parseInt(customerId), total_price: parseFloat(amount), 
                description: description || 'Customer Payment Received',
            };
            handleFormSubmit('transactions', payload, 'addCR');
        };

        return (
            <ModalForm title="Record Customer Payment (CR)" isOpen={modal.addCR} onClose={() => closeModal('addCR')}>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} required className="w-full p-2 border rounded-md">
                        <option value="">Select Customer</option>
                        {customers.map(c => <option key={c.id} value={c.id}>{c.name} (Owed: ₹{getCustomerFinancials(c.id).borrowings.toFixed(2)})</option>)}
                    </select>
                    <input type="number" step="0.01" placeholder="Amount Received (₹)" value={amount} onChange={(e) => setAmount(e.target.value)} required className="w-full p-2 border rounded-md" />
                    <input type="text" placeholder="Description (Optional)" value={description} onChange={(e) => setDescription(e.target.value)} className="w-full p-2 border rounded-md" />
                    <button type="submit" className="w-full bg-blue-600 text-white font-medium py-2 rounded-lg hover:bg-blue-700 transition">Record Payment</button>
                </form>
            </ModalForm>
        );
    };
    
    // 6. Add Expense Modal 
    const AddExpenseModal = () => {
        const [description, setDescription] = useState('');
        const [amount, setAmount] = useState('');
        const [date, setDate] = useState(new Date().toISOString().split('T')[0]); 

        const handleSubmit = (e) => {
            e.preventDefault();
            const payload = { description, amount: parseFloat(amount), date }; 
            handleFormSubmit('expenses', payload, 'addExpense');
        };

        return (
            <ModalForm title="Record New Operating Expense" isOpen={modal.addExpense} onClose={() => closeModal('addExpense')}>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required className="w-full p-2 border rounded-md" />
                    <input type="text" placeholder="Description (e.g., Office Rent, Salary, Cash)" value={description} onChange={(e) => setDescription(e.target.value)} required className="w-full p-2 border rounded-md" />
                    <input type="number" step="0.01" placeholder="Amount (₹)" value={amount} onChange={(e) => setAmount(e.target.value)} required className="w-full p-2 border rounded-md" />
                    <button type="submit" className="w-full bg-yellow-600 text-white font-medium py-2 rounded-lg hover:bg-yellow-700 transition">Record Expense</button>
                </form>
            </ModalForm>
        );
    };
    
    // 7. Customer P&L Breakdown Modal 
    const CustomerPnlModal = () => {
        const customerPnlData = useMemo(() => {
            return customers.map(c => ({
                id: c.id,
                name: c.name,
                ...getCustomerFinancials(c.id) 
            })).sort((a, b) => b.grossProfit - a.grossProfit); 
        }, [customers, getCustomerFinancials]);

        const totalGrossProfit = customerPnlData.reduce((sum, c) => sum + c.grossProfit, 0);

        return (
            <Modal 
                title="Gross Profit Breakdown by Customer" 
                isOpen={modal.customerPnl} 
                onClose={() => closeModal('customerPnl')}
            >
                <div className="space-y-4">
                    <div className="p-4 rounded-lg bg-indigo-50 border border-indigo-200 flex justify-between items-center font-bold text-lg">
                        <span>Total Gross Profit</span>
                        <span className={totalGrossProfit >= 0 ? 'text-green-700' : 'text-red-700'}>
                            ₹{totalGrossProfit.toFixed(2)}
                        </span>
                    </div>

                    <div className="max-h-96 overflow-y-auto divide-y divide-gray-200 border rounded-lg">
                        <div className="flex bg-gray-50 font-semibold text-sm uppercase text-gray-600 sticky top-0">
                            <span className="p-3 w-1/2">Customer</span>
                            <span className="p-3 w-1/4 text-right">Revenue</span>
                            <span className="p-3 w-1/4 text-right">Gross Profit</span>
                        </div>
                        {customerPnlData.length > 0 ? (
                            customerPnlData.map((c) => (
                                <div key={c.id} className="flex hover:bg-gray-50">
                                    <span className="p-3 w-1/2 text-sm text-gray-800 font-medium">{c.name}</span>
                                    <span className="p-3 w-1/4 text-sm text-right text-indigo-600">
                                        ₹{c.sellValue.toFixed(2)}
                                    </span>
                                    <span 
                                        className={c.grossProfit >= 0 ? 'p-3 w-1/4 text-sm text-right font-semibold text-green-600' : 'p-3 w-1/4 text-sm text-right font-semibold text-red-600'}
                                    >
                                        ₹{c.grossProfit.toFixed(2)}
                                    </span>
                                </div>
                            ))
                        ) : (
                            <p className="p-4 text-center text-gray-500 text-sm">No customer sales recorded yet.</p>
                        )}
                    </div>
                    
                    <p className="text-xs text-gray-500 mt-4">Gross Profit (GP) is calculated as Customer Revenue minus Cost of Goods Sold (COGS). This is before subtracting operating expenses.</p>
                </div>
            </Modal>
        );
    };


    // --- View Components (Identical to previous, only included DashboardView for context) ---

    const DashboardView = () => {
        const { 
            totalRevenue, totalCOGS, totalCurrentStockValue, 
            borrowings, netProfit, totalOperatingExpenses,
            totalCashWithdrawal, adjustedNetProfit
        } = dashboardMetrics;
        
        const netProfitValue = netProfit ? netProfit.toFixed(2) : '0.00';
        const borrowingValue = Math.abs(borrowings || 0).toFixed(2);
        
        const adjNetProfitValue = adjustedNetProfit.toFixed(2);
        const withdrawalValue = totalCashWithdrawal.toFixed(2);


        return (
            <div className="space-y-6">
                <div className="flex justify-between items-center mb-4">
                    <h2 className="text-2xl font-semibold
                    text-gray-700">Financial Summary</h2>
                    <div className="space-x-2">
                         {user && <span className="text-sm font-medium text-gray-600 mr-2">Hello, {user.username}</span>}
                        <button onClick={handleLogout} className="bg-gray-500 text-white text-sm px-3 py-1.5 rounded-md shadow-lg font-bold hover:bg-gray-600 transition">
                            Logout
                        </button>
                    </div>
                </div>

                {/* Net Profit / Loss Card */}
                <MetricCard 
                    title="NET PROFIT / LOSS (BEFORE DRAWING)" 
                    value={netProfitValue} 
                    valueColorClass={netProfit >= 0 ? 'text-green-700' : 'text-red-700'} 
                    prefix={'₹'}
                    icon={netProfit >= 0 ? '📈' : '📉'}
                    isLarge={true}
                    onClick={() => openModal('customerPnl')}
                />

                <div className="grid grid-cols-2 gap-4">
                    {/* Row 2 (Four cards) */}
                    <MetricCard title="TOTAL REVENUE" value={totalRevenue ? totalRevenue.toFixed(2) : '0.00'} valueColorClass="text-indigo-600" icon='💲'/>
                    <MetricCard title="COST OF SALES (COGS)" value={totalCOGS ? totalCOGS.toFixed(2) : '0.00'} valueColorClass="text-red-600" icon='📊'/>
                    <MetricCard title="CURRENT STOCK VALUE" value={totalCurrentStockValue ? totalCurrentStockValue.toFixed(2) : '0.00'} valueColorClass="text-green-600" icon='📦'/>
                    <MetricCard title="TOTAL BORROWINGS" value={borrowingValue} valueColorClass={borrowings > 0 ? 'text-red-600' : 'text-gray-700'} icon='🧾'/>
                    
                    {/* Row 3 (Two cards) */}
                    <MetricCard 
                        title="OPERATING EXPENSES (EXCL. DRAWING)" 
                        value={totalOperatingExpenses ? totalOperatingExpenses.toFixed(2) : '0.00'} 
                        valueColorClass="text-red-600" 
                        icon='💸'
                    />

                    {/* Adjusted Net Profit Summary */}
                    <div className="bg-white p-4 rounded-xl shadow-md flex flex-col justify-between border-b-4 border-yellow-500">
                        <p className="text-xs font-medium text-gray-500 uppercase">ADJUSTED NET PROFIT SUMMARY</p>
                        <div className="mt-2 space-y-1">
                            <p className="text-sm text-gray-700">
                                <span className="font-semibold text-yellow-600">Total Deduction:</span> 
                                {' '}₹{withdrawalValue} (Cash Withdrawal)
                            </p>
                            <p className={`text-sm ${adjustedNetProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                <span className="font-semibold text-gray-700">Adj. Net Profit:</span> 
                                {' '}₹{adjNetProfitValue}
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    const StockView = () => { /* ... (View implementation omitted for brevity) ... */ return <div><div className="flex justify-between items-center mb-4"><h2 className="text-xl font-semibold text-gray-700">Current Stock Details</h2><button onClick={() => openModal('addMaterial')} className="bg-indigo-600 text-white text-sm px-3 py-1.5 rounded-md shadow-lg font-bold hover:bg-indigo-700 transition">+ Add New Material</button></div><div className="bg-white card overflow-x-auto shadow-lg rounded-xl"><table className="min-w-full divide-y divide-gray-200"><thead className="bg-gray-50"><tr><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Sr no.</th><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Material Name</th><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Colour</th><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Quantity</th><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Value</th><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">WAC (Cost/Unit)</th><th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-16">Action</th></tr></thead><tbody className="divide-y divide-gray-200">{Object.values(materialWACData).map((m, index) => <tr key={m.id} className="border-b hover:bg-gray-50"><td className="px-4 py-3 text-sm font-medium text-gray-900">{index + 1}</td><td className="px-4 py-3 text-sm text-indigo-600 font-medium">{m.name}</td><td className="px-4 py-3 text-sm text-gray-500">{m.color || 'N/A'}</td><td className={`px-4 py-3 text-sm ${m.currentQuantity === 0 ? 'text-gray-400 italic' : 'text-gray-700 font-medium'}`}>{m.currentQuantity.toFixed(2)}</td><td className="px-4 py-3 text-sm text-gray-700 font-medium">₹{m.stockValue.toFixed(2)}</td><td className="px-4 py-3 text-sm text-gray-700">₹{m.wac.toFixed(2)}</td><td className="px-4 py-3 text-sm text-center w-16"><button onClick={() => triggerDelete(m.id, 'materials', m.name)} className="text-red-500 hover:text-red-700 p-1 rounded hover:bg-red-100 transition" title={`Delete material: ${m.name}`}>🗑️</button></td></tr>)}</tbody></table></div></div>; };
    const CustomersView = () => { /* ... (View implementation omitted for brevity) ... */ return <div><div className="flex justify-between items-center mb-4"><h2 className="text-xl font-semibold text-gray-700">Customer Details</h2><button onClick={() => openModal('addCustomer')} className="bg-indigo-600 text-white text-sm px-3 py-1.5 rounded-md shadow-lg font-bold hover:bg-indigo-700 transition">+ Add New Customer</button></div><div className="bg-white card overflow-x-auto shadow-lg rounded-xl"><table className="min-w-full divide-y divide-gray-200"><thead className="bg-gray-50"><tr><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Customer Name</th><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Sell Value</th><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Money Received</th><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Borrowings</th><th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-16">Action</th></tr></thead><tbody className="divide-y divide-gray-200">{customers.map(c => ({...c, ...getCustomerFinancials(c.id)})).map(c => <tr key={c.id} className="border-b hover:bg-gray-50"><td className="px-4 py-3 text-sm text-indigo-600 font-medium cursor-pointer hover:underline" onClick={() => openModal('customerHistory', { customerId: c.id, customerName: c.name })}>{c.name}</td><td className="px-4 py-3 text-sm text-gray-700">₹{c.sellValue.toFixed(2)}</td><td className="px-4 py-3 text-sm text-green-600">₹{c.actualValue.toFixed(2)}</td><td className={`px-4 py-3 text-sm font-medium ${c.borrowings > 0 ? 'text-red-600' : 'text-green-600'}`}>₹{c.borrowings.toFixed(2)}</td><td className="px-4 py-3 text-sm text-center w-16"><button onClick={() => triggerDelete(c.id, 'customers', c.name)} className="text-red-500 hover:text-red-700 p-1 rounded hover:bg-red-100 transition" title={`Delete customer: ${c.name}`}>🗑️</button></td></tr>)}</tbody></table></div></div>; };
    const CRView = () => { /* ... (View implementation omitted for brevity) ... */ return <div className="bg-white card p-6 space-y-6 shadow-lg rounded-xl"><h2 className="text-xl font-semibold text-gray-700">Credit Reconciliation (CR)</h2><button onClick={() => openModal('addCR')}className="w-full bg-blue-600 text-white font-medium py-3 rounded-lg shadow-lg hover:bg-blue-700 transition">Record Customer Payment</button><h3 className="text-lg font-medium text-gray-700 border-t pt-4">Customers with Outstanding Borrowings</h3><ul className="space-y-3">{customers.map(c => ({...c, borrowings: getCustomerFinancials(c.id).borrowings})).filter(c => c.borrowings > 0).map(c => (<li key={c.id} className="p-3 border border-red-300 rounded-md flex justify-between items-center bg-red-50"><span className="font-medium text-gray-800">{c.name}</span><span className="text-red-600 font-semibold">Owed: ₹{c.borrowings.toFixed(2)}</span></li>))}</ul></div>; };
    const ExpensesView = () => { /* ... (View implementation omitted for brevity) ... */ const total = operatingExpenses.reduce((sum, e) => sum + parseFloat(e.amount || 0), 0); return <div><div className="flex justify-between items-center mb-4"><h2 className="text-xl font-semibold text-gray-700">Operating Expenses Ledger</h2><button onClick={() => openModal('addExpense')} className="bg-yellow-600 text-white text-sm px-3 py-1.5 rounded-md shadow-lg font-bold hover:bg-yellow-700 transition">+ Record Expense</button></div><div className="bg-white p-4 mb-6 rounded-xl shadow-md border-b-4 border-red-400"><p className="text-sm font-medium text-gray-500">Total Entries in Expense Ledger (Includes Drawings)</p><p className="text-2xl font-bold text-red-600 mt-1">₹{total.toFixed(2)}</p></div><div className="bg-white card overflow-x-auto shadow-lg rounded-xl"><table className="min-w-full divide-y divide-gray-200"><thead className="bg-gray-50"><tr><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Description</th><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Amount</th><th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-16">Action</th></tr></thead><tbody className="divide-y divide-gray-200">{operatingExpenses.map(e => {const isCashWithdrawal = e.description && e.description.toLowerCase().trim() === 'cash'; const rowClass = isCashWithdrawal ? 'bg-yellow-50 border-b-2 border-yellow-300 hover:bg-yellow-100' : 'border-b hover:bg-gray-50'; const descriptionText = isCashWithdrawal ? `${e.description} (CASH DRAWING - EQUITY)` : e.description; return (<tr key={e.id} className={rowClass}><td className="px-4 py-3 text-sm text-gray-700">{e.timestamp?.toDate().toLocaleDateString() || 'N/A'}</td><td className="px-4 py-3 text-sm text-gray-700">{descriptionText || '-'}</td><td className="px-4 py-3 text-sm text-red-600 font-medium">₹{parseFloat(e.amount || 0).toFixed(2)}</td><td className="px-4 py-3 text-sm text-center w-16"><button onClick={() => triggerDelete(e.id, 'expenses', `${e.description} (₹${parseFloat(e.amount || 0).toFixed(2)})`)} className="text-red-500 hover:text-red-700 p-1 rounded hover:bg-red-100 transition" title={`Delete expense: ${e.description}`}>🗑️</button></td></tr>);})}</tbody></table></div></div>; };
    const HistoryView = () => { /* ... (View implementation omitted for brevity) ... */ return <div><h2 className="text-xl font-semibold text-gray-700 mb-4">Transaction History</h2><div className="bg-white card overflow-x-auto shadow-lg rounded-xl"><table className="min-w-full divide-y divide-gray-200"><thead className="bg-gray-50"><tr><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Material</th><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Customer</th><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Quantity</th><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Value</th><th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-16">Action</th></tr></thead><tbody className="divide-y divide-gray-200">{history.map(t => <tr key={t.id} className="border-b hover:bg-gray-50"><td className={`px-4 py-3 text-sm font-medium ${t.transaction_type === 'CR' ? 'text-green-600' : (t.transaction_type === 'DB' ? 'text-red-600' : 'text-blue-600')}`}>{t.transaction_type || '-'}</td><td className="px-4 py-3 text-sm text-gray-700">{t.timestamp?.toDate().toLocaleDateString() || 'N/A'}</td><td className="px-4 py-3 text-sm text-gray-700">{t.material ? getMaterialName(t.material) : '-'}</td><td className="px-4 py-3 text-sm text-gray-700">{t.customer ? getCustomerName(t.customer) : '-'}</td><td className="px-4 py-3 text-sm text-gray-700">{parseFloat(t.quantity || 0).toFixed(2)}</td><td className="px-4 py-3 text-sm text-gray-700">₹{parseFloat(t.total_price || 0).toFixed(2)}</td><td className="px-4 py-3 text-sm text-center w-16"><button onClick={() => triggerDelete(t.id, 'transactions', `${t.transaction_type || 'TX'} of ${parseFloat(t.quantity || 0).toFixed(2)}`)} className="text-red-500 hover:text-red-700 p-1 rounded hover:bg-red-100 transition" title="Delete Transaction">🗑️</button></td></tr>)}</tbody></table></div></div>; };


    // --- Dynamic Render ---
    const renderView = () => {
        if (!isAuthenticated) {
            return <LoginPage onLoginSuccess={handleLoginSuccess} setError={setError} />;
        }

        if (loading) return <p className="text-center p-8 text-indigo-600 font-semibold text-lg">Loading data from Django backend...</p>;
        
        switch (currentView) {
            case 'dashboard': return <DashboardView />;
            case 'stock': return <StockView />;
            case 'customers': return <CustomersView />;
            case 'cr': return <CRView />;
            case 'expenses': return <ExpensesView />; 
            case 'history': return <HistoryView />;
            default: return <DashboardView />;
        }
    };

    const navItems = [
        { id: 'dashboard', label: 'P&L', icon: '🏠' },
        { id: 'stock', label: 'Stock', icon: '📦' },
        { id: 'customers', label: 'Customers', icon: '👥' },
        { id: 'cr', label: 'CR', icon: '💲' },
        { id: 'expenses', label: 'Expenses', icon: '💰' }, 
        { id: 'history', label: 'History', icon: '🕒' },
    ];

    // --- JSX Return ---
    return (
        <div className="min-h-screen bg-gray-50 font-sans">
            <div id="app-container" className="max-w-4xl mx-auto p-4 md:p-6 pb-20">
              {isAuthenticated && (  <h1 className="text-3xl font-bold
              text-indigo-600 mb-6 border-b pb-2">Ledger Manager Hello,
              {user.username} </h1> )}

                <div id="content-area">
                    {renderView()}
                </div>
            </div>
            
            {/* --- BOTTOM NAVIGATION BAR (Only visible when authenticated) --- */}
            {isAuthenticated && (
                <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-2xl z-50">
                    <div className="flex justify-around items-center h-16 max-w-xl mx-auto">
                        {navItems.map(item => (
                            <button
                                key={item.id}
                                onClick={() => setCurrentView(item.id)}
                                className={`flex flex-col items-center justify-center p-1 text-xs transition duration-150 ease-in-out w-1/5 h-full 
                                    ${currentView === item.id ? 'text-indigo-600' : 'text-gray-500 hover:text-indigo-400'}
                                `}
                            >
                                <span className={`text-xl mb-0.5 ${currentView === item.id ? 'scale-110' : ''}`}>{item.icon}</span>
                                <span className="font-medium">{item.label}</span>
                            </button>
                        ))}
                    </div>
                </nav>
            )}


            {/* --- Modals --- */}
            {error && (
                <div className="fixed top-4 right-4 z-50 p-4 bg-red-100 border border-red-400 text-red-700 rounded-lg shadow-xl animate-bounce" role="alert">
                    <p className="font-bold">Error:</p>
                    <p className="text-sm">{error}</p>
                    <button onClick={() => setError('')} className="absolute top-1 right-1 text-red-700 hover:text-red-900 transition font-bold text-lg">×</button>
                </div>
            )}
            
            {/* Data Entry Forms (Only render if authenticated to prevent submission of bad data) */}
            {isAuthenticated && (
                <>
                    <AddCustomerModal />
                    <AddCreditModal />
                    <AddDebitModal />
                    <AddMaterialModal />
                    <AddExpenseModal /> 
                    <AddCRModal />
                    <ConfirmationModal />
                    <CustomerPnlModal /> 
                    <Modal title={`${transactionData.customerName || 'Customer'}'s Ledger (WIP)`} isOpen={modal.customerHistory} onClose={() => closeModal('customerHistory')}>
                        <p className="text-gray-600">Customer history drilldown display is omitted for brevity.</p>
                    </Modal>
                </>
            )}
            
        </div>
    );
};

export default App;

