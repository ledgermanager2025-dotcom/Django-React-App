import React, { useState, useEffect, useMemo, useCallback } from 'react';

// --- API and Auth Configuration ---
// NOTE: This URL must be pointing to your running Django backend server.
const API_BASE_URL = 'http://localhost:8000/api'; 
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

/**
 * Decodes a JWT and extracts the payload.
 * @param {string} token - The JWT string.
 * @returns {object|null} The decoded payload object.
 */
const decodeToken = (token) => {
    if (!token) return null;
    try {
        const base64Url = token.split('.')[1];
        // Replace base64 URL-safe characters with standard base64 characters
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        // Pad the base64 string to be a multiple of 4
        const paddedBase64 = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=');
        
        // Use atob and JSON.parse
        const jsonPayload = atob(paddedBase64);
        
        return JSON.parse(jsonPayload);
    } catch (e) {
        console.error("Failed to decode token:", e);
        return null;
    }
};

/**
 * Attempts to get a new access token using the stored refresh token.
 * @returns {string|null} The new access token, or null on failure.
 */
const attemptTokenRefresh = async () => {
    const tokens = getTokens();
    if (!tokens.refresh) {
        console.warn("Refresh failed: No refresh token found.");
        return null;
    }

    try {
        const response = await fetch(REFRESH_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh: tokens.refresh }),
        });

        if (!response.ok) {
            console.error("Refresh failed. Server response:", response.status);
            // If refresh fails (e.g., refresh token is also expired or invalid), we must clear all tokens.
            clearTokens();
            return null; 
        }

        const newTokens = await response.json();
        setTokens(newTokens); // Save new access token (and potential new refresh token)
        return newTokens.access;

    } catch (error) {
        console.error("Error during token refresh:", error);
        clearTokens();
        return null;
    }
};


/** * Authenticated Fetch Wrapper: Attaches Authorization header, handles 401 errors, 
 * and attempts token refresh if the access token has expired.
 */
const authFetch = async (endpoint, options = {}, isRetry = false) => {
    const tokens = getTokens();
    
    // Check for token existence before proceeding
    if (!tokens.access && !isRetry) {
         // If we are not retrying and no access token exists, we cannot proceed.
         throw new Error('No access token found. Please log in.');
    }

    const headers = {
        'Authorization': `Bearer ${tokens.access}`,
        'Content-Type': 'application/json',
        ...options.headers,
    };
    
    // 1. Perform the initial fetch
    let response = await fetch(endpoint, {
        ...options,
        headers: headers,
    });
    
    // 2. Check for 401 (Unauthorized)
    if (response.status === 401 && !isRetry) {
        console.log("Access token expired. Attempting refresh...");
        
        const newAccessToken = await attemptTokenRefresh();
        
        if (newAccessToken) {
            // 3. Refresh succeeded, retry the original request
            console.log("Token refreshed. Retrying request...");
            
            // Update options with the new token for the retry
            const retryOptions = { 
                ...options, 
                headers: { 
                    ...options.headers, 
                    'Authorization': `Bearer ${newAccessToken}`
                } 
            };

            // Call authFetch recursively, marking it as a retry
            return authFetch(endpoint, retryOptions, true);
            
        } else {
            // 4. Refresh failed, force main logout
            clearTokens(); // Ensure tokens are cleared
            throw new Error('Unauthorized or expired token. Refresh failed. Session ended.');
        }
    } else if (response.status === 401 && isRetry) {
        // 5. Retry failed (e.g., new token immediately invalid or other issue). Force logout.
        clearTokens(); // Ensure tokens are cleared
        throw new Error('Unauthorized or expired token. Session ended.');
    }

    return response;
};

/** Helper to fetch data from the API and handle errors */
const fetchData = async (endpoint) => {
    try {
        // authFetch now handles the token refresh automatically
        const response = await authFetch(`${API_BASE_URL}/${endpoint}/`); 
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP error! status: ${response.status} - ${errorText.substring(0, 100)}...`);
        }
        const data = await response.json();
        
        return data.map(item => ({
            ...item,
            // Convert Django's ISO date string to a Firebase-compatible object structure
            // This is primarily for consistency with the rest of the original code's date handling
            timestamp: { 
                toDate: () => new Date(item.timestamp || item.date || null) 
            } 
        }));
    } catch (error) {
        // Re-throw if it's the specific unauthorized error to trigger app-level logout
        if (error.message.includes('Unauthorized or expired token') || error.message.includes('No access token found')) {
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
        if (error.message.includes('Unauthorized or expired token') || error.message.includes('No access token found')) {
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
        if (error.message.includes('Unauthorized or expired token') || error.message.includes('No access token found')) {
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
            <div className="bg-white w-full max-w-lg p-6 rounded-xl shadow-2xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
                <h2 className="text-2xl font-semibold mb-4 text-gray-800 border-b pb-2">{title}</h2>
                <div className="overflow-y-auto flex-grow">{children}</div>
                <div className="flex justify-end mt-4 space-x-3 border-t pt-3">
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
        className={`bg-white p-3 rounded-xl shadow-sm flex ${isLarge ? 'flex-row items-center justify-between' : 'flex-col'} ${onClick ? 'cursor-pointer hover:shadow-lg transition transform hover:scale-[1.01]' : ''} border-b-2 ${valueColorClass.includes('green') ? 'border-green-500' : valueColorClass.includes('red') ? 'border-red-500' : 'border-gray-500'}`}
        onClick={onClick}
    >
        <div className={`flex items-center ${isLarge ? '' : 'mb-2'}`}>
            {icon && <span className={`text-2xl mr-3 ${isLarge ? 'text-4xl text-indigo-600' : 'text-xl text-gray-600'}`}>{icon}</span>}
            <p className={`text-xs font-medium text-gray-500 uppercase ${isLarge ? 'text-lg' : ''}`}>{title}</p>
        </div>
        <p className={`${isLarge ? 'text-3xl' : 'text-2xl'} font-medium mt-1 ${valueColorClass}`}>{prefix}{value}</p>
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
            
            // On successful login, pass the username directly to the parent
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
    const [startingCapital, setStartingCapital] = useState(0); // ✨ NEW STATE for Capital

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
        setStartingCapital(0); // Clear capital on logout
        setLoading(false); 
        setError('');
    }, []);

    // Initial Auth Check on load
    useEffect(() => {
        const tokens = getTokens();
        const currentAccessToken = tokens.access;
        const currentRefreshToken = tokens.refresh;
        
        if (currentAccessToken) {
            // 1. Try to decode the existing access token
            const payload = decodeToken(currentAccessToken);
            const username = payload?.username; 
            const now = Date.now() / 1000;

            if (username && payload.exp > now) {
                // Access token is valid
                setIsAuthenticated(true);
                setUser({ username });
                setLoading(true); 
                setRefetchKey(prev => prev + 1); // Trigger data fetch
            } else if (currentRefreshToken) {
                // 2. Access token is expired, but refresh token exists. Attempt refresh.
                console.log("Access token expired on load. Attempting refresh...");
                const refreshOnLoad = async () => {
                    const newAccessToken = await attemptTokenRefresh();
                    if (newAccessToken) {
                        const newPayload = decodeToken(newAccessToken);
                        setIsAuthenticated(true);
                        setUser({ username: newPayload?.username });
                        setRefetchKey(prev => prev + 1); // Trigger data fetch
                    } else {
                        // Refresh failed (refresh token expired/invalid)
                        handleLogout();
                        setError('Session expired. Please log in.');
                    }
                    setLoading(false);
                };
                refreshOnLoad();
                
            } else {
                // If token exists but is invalid/unreadable or no refresh token, clear it and force login
                clearTokens();
                setLoading(false);
            }
        } else {
            // No tokens found
            setLoading(false);
        }
    
    // We must include handleLogout in dependencies because it's used inside the effect
    // eslint-disable-next-line react-hooks/exhaustive-deps 
    }, [handleLogout]);


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
                // ✨ UPDATED: Fetching Starting Capital
                const [mats, custs, trans, exps, caps] = await Promise.all([
                    fetchData('materials'),
                    fetchData('customers'),
                    fetchData('transactions'),
                    fetchData('expenses'),
                    fetchData('startingcapital') // Assuming 'startingcapital' is the endpoint
                ]);

                setMaterials(mats);
                setCustomers(custs);
                setHistory(trans);
                setOperatingExpenses(exps);
                
                // Set Starting Capital (assuming it's a list and we take the first item's amount)
                const initialCapital = caps.length > 0 ? parseFloat(caps[0].amount || 0) : 0;
                setStartingCapital(initialCapital);
                
            } catch (err) {
                // Check if the error is due to session ending
                if (err.message.includes('Unauthorized or expired token') || err.message.includes('No access token found')) {
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
    }, [refetchKey, isAuthenticated, handleLogout]); 


    // --- Data Lookups & Calculation Helpers ---
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
                // Ensure material exists and wac is a valid number
                totalCOGS += parseFloat(t.quantity || 0) * (materialData.wac || 0);
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
                    acc.totalCOGS += parseFloat(t.quantity || 0) * (materialData.wac || 0);
                }
            } else if (t.transaction_type === 'RC') {
                acc.moneyReceived += parseFloat(t.total_price || 0); 
            }
            // ✨ NEW: Calculate Total Purchase Value (CR transactions)
            else if (t.transaction_type === 'CR') {
                acc.totalPurchaseValue += parseFloat(t.total_price || 0);
            }
            return acc;
        }, { totalRevenue: 0, moneyReceived: 0, totalCOGS: 0, totalPurchaseValue: 0 }); // Initialize totalPurchaseValue

        
        // Operative expenses (that contribute to P&L calculation)
        const operativeExpenses = operatingExpenses.filter(e => 
            e.expense_type !== 'Personal' // Assuming 'Personal' is the drawing type
        ).reduce((sum, e) => sum + parseFloat(e.amount || 0), 0);
        
        // Personal expenses/Drawings (cash withdrawal)
        const totalCashWithdrawal = operatingExpenses
            .filter(e => e.expense_type === 'Personal')
            .reduce((sum, e) => sum + parseFloat(e.amount || 0), 0);
        
        const totalCurrentStockValue = Object.values(materialWACData).reduce((sum, m) => sum + m.stockValue, 0);
        
        // Calculate total sell value from DB transactions only
        const totalSellValue = history
            .filter(t => t.transaction_type === 'DB')
            .reduce((sum, t) => sum + parseFloat(t.total_price || 0), 0);
        
        const totalMoneyReceived = metrics.moneyReceived;

        metrics.borrowings = totalSellValue - totalMoneyReceived;
        metrics.totalCurrentStockValue = totalCurrentStockValue;
        
        metrics.totalOperatingExpenses = operativeExpenses; 

        // Net Profit before drawing
        metrics.netProfit = metrics.totalRevenue - metrics.totalCOGS - metrics.totalOperatingExpenses - metrics.borrowings; 
        
        metrics.totalCashWithdrawal = totalCashWithdrawal;
        
        // Net Profit after drawing
        metrics.adjustedNetProfit = metrics.netProfit - metrics.totalCashWithdrawal;
        
        // ✨ NEW CALCULATION: Available Cash
        // Logic: Starting Capital + Total Money Received - Total Purchases (CR) - All Expenses
        const availableCash = 
            startingCapital +
            totalMoneyReceived - // Total Money Received (from DB sales & RC payments)
            metrics.totalPurchaseValue - // Total Purchases (CR transactions)
            metrics.totalOperatingExpenses - // Operative Expenses
            metrics.totalCashWithdrawal; // Personal Expenses (Drawing)
            
        metrics.startingCapital = startingCapital;
        metrics.availableCash = availableCash; 
        
        return metrics;
    }, [history, materialWACData, operatingExpenses, startingCapital]); // ✨ Added startingCapital dependency

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
            if (err.message.includes('Unauthorized or expired token') || err.message.includes('No access token found')) {
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
                if (err.message.includes('Unauthorized or expired token') || err.message.includes('No access token found')) {
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

    // --- Data Entry Modals ---

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
        const [customerId, setCustomerId] = useState(transactionData.customerId || '');
        const [amount, setAmount] = useState('');
        const [description, setDescription] = useState('');
        
        // Update customerId if transactionData changes (e.g., from CustomerHistoryModal)
        useEffect(() => {
            if (transactionData.customerId) {
                setCustomerId(transactionData.customerId);
            }
        }, [transactionData.customerId]);


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
                    <select 
                        value={customerId} 
                        onChange={(e) => setCustomerId(e.target.value)} 
                        required 
                        className="w-full p-2 border rounded-md"
                    >
                        <option value="">Select Customer</option>
                        {customers.map(c => (
                            <option key={c.id} value={c.id}>
                                {c.name} (Owed: ₹{getCustomerFinancials(c.id).borrowings.toFixed(2)})
                            </option>
                        ))}
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
    // Ensure date is a string in YYYY-MM-DD format for input type="date"
    const [date, setDate] = useState(new Date().toISOString().split('T')[0]); 
    // Default to the first type if multiple are available
    const [expense_type, setExpenseType] = useState('Operative'); 
    
    const EXPENSE_TYPES = [
        { label: 'Operative Expense (P&L)', value: 'Operative' },
        { label: 'Personal Expense (Drawing)', value: 'Personal' }
    ];

    const handleSubmit = (e) => {
        e.preventDefault();
        const payload = { description, amount: parseFloat(amount), date, expense_type }; 
        handleFormSubmit('expenses', payload, 'addExpense');
    };
    
    return (
        <ModalForm title="Record New Expense" isOpen={modal.addExpense} onClose={() => closeModal('addExpense')}>
            <form onSubmit={handleSubmit} className="space-y-4">
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required className="w-full p-2 border rounded-md" />
                <input type="text" placeholder="Description (e.g., Office Rent, Salary, Cash)" value={description} onChange={(e) => setDescription(e.target.value)} required className="w-full p-2 border rounded-md" />
                <input type="number" step="0.01" placeholder="Amount (₹)" value={amount} onChange={(e) => setAmount(e.target.value)} required className="w-full p-2 border rounded-md" />
                
                {/* New Expense Type Selector */}
                <select 
                    value={expense_type} 
                    onChange={(e) => setExpenseType(e.target.value)} 
                    required 
                    className="w-full p-2 border rounded-md bg-white"
                >
                    <option value="">Select Expense Type</option>
                    {EXPENSE_TYPES.map(type => (
                        <option key={type.value} value={type.value}>{type.label}</option>
                    ))}
                </select>
                
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

    // 8. Customer Transaction History Modal
    const CustomerHistoryModal = () => {
        const { customerId, customerName } = transactionData;
        
        // Filter transactions for the selected customer and sort by date
        const customerTransactions = useMemo(() => {
            if (!customerId) return [];
            return history
                .filter(t => t.customer === customerId)
                .sort((a, b) => b.timestamp.toDate() - a.timestamp.toDate()); // Sort newest first
        }, [customerId, history]);

        // Calculate running balance/borrowings for the customer
        const runningFinancials = useMemo(() => {
            if (!customerId) return { borrowings: 0 };
            return getCustomerFinancials(customerId);
        }, [customerId, getCustomerFinancials]);

        if (!customerId) return null;

        return (
            <Modal 
                title={`${customerName}'s Transaction History`} 
                isOpen={modal.customerHistory} 
                onClose={() => closeModal('customerHistory')}
            >
                <div className="space-y-4">
                    <div className="max-h-96 overflow-y-auto scrollbar-custom border rounded-lg shadow-inner">
                        <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-50 sticky top-0">
                                <tr>
                                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Details</th>
                                    <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Amount</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                                {customerTransactions.length > 0 ? (
                                    customerTransactions.map(t => {
                                        const isSale = t.transaction_type === 'DB';
                                        const isPayment = t.transaction_type === 'RC';
                                        
                                        const typeText = isSale ? 'Sale' : (isPayment ? 'Payment Received' : 'Other');
                                        const typeColor = isSale ? 'text-red-600' : (isPayment ? 'text-green-600' : 'text-gray-500');
                                        
                                        let amountValue = parseFloat(t.total_price || 0);
                                        let amountDisplay = `₹${amountValue.toFixed(2)}`;
                                        
                                        let detailsText = '';
                                        if (isSale) {
                                            const materialName = getMaterialName(t.material);
                                            const received = parseFloat(t.money_received || 0).toFixed(2);
                                            const quantity = parseFloat(t.quantity || 0).toFixed(2);
                                            detailsText = `${materialName} (${quantity} units). Received: ₹${received}`;
                                        } else if (isPayment) {
                                            detailsText = t.description || 'Customer credit reconciliation.';
                                        }
                                        
                                        return (
                                            <tr key={t.id} className="hover:bg-gray-50">
                                                <td className="px-4 py-2 text-sm text-gray-500 whitespace-nowrap">
                                                    {t.timestamp?.toDate().toLocaleDateString() || 'N/A'}
                                                </td>
                                                <td className={`px-4 py-2 text-sm font-medium ${typeColor} whitespace-nowrap`}>
                                                    {typeText}
                                                </td>
                                                <td className="px-4 py-2 text-sm text-gray-700">
                                                    {detailsText}
                                                </td>
                                                <td className={`px-4 py-2 text-sm font-semibold text-right ${typeColor} whitespace-nowrap`}>
                                                    {amountDisplay}
                                                </td>
                                            </tr>
                                        );
                                    })
                                ) : (
                                    <tr>
                                        <td colSpan="4" className="text-center py-4 text-gray-500 italic">No transactions found for this customer.</td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                    
                    {/* Add button to record new payment */}
                    <button 
                        onClick={() => { closeModal('customerHistory'); openModal('addCR', { customerId: customerId, customerName: customerName }); }} 
                        className="w-full bg-blue-600 text-white font-medium py-2 rounded-lg hover:bg-blue-700 transition mt-4"
                    >
                        Record New Payment from {customerName}
                    </button>

                </div>
            </Modal>
        );
    };


    // --- View Components ---

    const DashboardView = () => {
        const { 
            totalRevenue, totalCOGS, totalCurrentStockValue, 
            borrowings, netProfit, totalOperatingExpenses,
            totalCashWithdrawal, 
            startingCapital, availableCash // ✨ NEW VALUES
        } = dashboardMetrics;
        
        const netProfitValue = netProfit ? netProfit.toFixed(2) : '0.00';
        const borrowingValue = Math.abs(borrowings || 0).toFixed(2);
        
        const withdrawalValue = totalCashWithdrawal.toFixed(2);
        
        // ✨ NEW CARD VALUES
        const capitalValue = startingCapital.toFixed(2);
        const cashValue = availableCash.toFixed(2);


        return (
            <div className="space-y-6">
                <div className="flex justify-between items-center mb-4">
                    <h2 className="text-2xl font-semibold text-gray-700">Financial Summary</h2>
                    <div className="space-x-2">
                        <button onClick={() => openModal('addCredit')} className="bg-green-500 text-white text-sm px-3 py-1.5 rounded-md shadow-lg font-bold hover:bg-green-600 transition">
                            + Purchase
                        </button>
                        <button onClick={() => openModal('addDebit')} className="bg-red-500 text-white text-sm px-3 py-1.5 rounded-md shadow-lg font-bold hover:bg-red-600 transition">
                            + Sale
                        </button>
                    </div>
                </div>

                {/* Net Profit / Loss Card */}
                <MetricCard 
                    title="NET PROFIT / LOSS" 
                    value={netProfitValue} 
                    valueColorClass={netProfit >= 0 ? 'text-green-700' : 'text-red-700'} 
                    prefix={'₹'}
                    icon={netProfit >= 0 ? '📈' : '📉'}
                    isLarge={true}
                    onClick={() => openModal('customerPnl')}
                />

                <div className="grid grid-cols-2 gap-4">
                    {/* Row 2 (Eight cards) */}
                    <MetricCard 
                        title="STARTING CAPITAL" 
                        value={capitalValue} 
                        valueColorClass="text-gray-500"
                        icon='🏛️'
                    />
                    <MetricCard 
                        title="AVAILABLE CASH" 
                        value={cashValue} 
                        valueColorClass={availableCash >= 0 ? 'text-gray-500' : 'text-red-600'}
                        icon='💵'
                    />
                    <MetricCard title="TOTAL REVENUE"
                        value={totalRevenue ? totalRevenue.toFixed(2) : '0.00'}
                        valueColorClass="text-gray-500" 
                        icon='💲'
                    />
                    <MetricCard title="CURRENT STOCK VALUE"
                        value={totalCurrentStockValue ?
                        totalCurrentStockValue.toFixed(2) : '0.00'}
                        valueColorClass="text-gray-500" 
                    icon='📦'
                    />
                    <MetricCard title="COST OF SALES" value={totalCOGS ? totalCOGS.toFixed(2) : '0.00'} valueColorClass="text-red-600" icon='📊'/>
                    <MetricCard title="TOTAL BORROWINGS" value={borrowingValue} valueColorClass={borrowings > 0 ? 'text-red-600' : 'text-gray-700'} icon='🧾'/>
                    <MetricCard 
                        title="OPERATIVE EXPENSES" 
                        value={totalOperatingExpenses ? totalOperatingExpenses.toFixed(2) : '0.00'} 
                        valueColorClass="text-red-600" 
                        icon='💸'
                    />
                    <MetricCard 
                        title="PERSONAL EXPENSES" 
                        value={withdrawalValue} 
                        valueColorClass="text-red-600" 
                        icon='💸'
                    />
                </div>
            </div>
        );
    };

    const StockView = () => { /* ... (View implementation omitted for brevity) ... */ return <div><div className="flex justify-between items-center mb-4"><h2 className="text-xl font-semibold text-gray-700">Current Stock Details</h2><button onClick={() => openModal('addMaterial')} className="bg-indigo-600 text-white text-sm px-3 py-1.5 rounded-md shadow-lg font-bold hover:bg-indigo-700 transition">+ Add New Material</button></div><div className="bg-white card overflow-x-auto shadow-lg rounded-xl"><table className="min-w-full divide-y divide-gray-200"><thead className="bg-gray-50"><tr><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Sr no.</th><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Material Name</th><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Colour</th><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Quantity</th><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Value</th><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">WAC (Cost/Unit)</th><th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-16">Action</th></tr></thead><tbody className="divide-y divide-gray-200">{Object.values(materialWACData).map((m, index) => <tr key={m.id} className="border-b hover:bg-gray-50"><td className="px-4 py-3 text-sm font-medium text-gray-900">{index + 1}</td><td className="px-4 py-3 text-sm text-indigo-600 font-medium">{m.name}</td><td className="px-4 py-3 text-sm text-gray-500">{m.color || 'N/A'}</td><td className={`px-4 py-3 text-sm ${m.currentQuantity === 0 ? 'text-gray-400 italic' : 'text-gray-700 font-medium'}`}>{m.currentQuantity.toFixed(2)}</td><td className="px-4 py-3 text-sm text-gray-700 font-medium">₹{m.stockValue.toFixed(2)}</td><td className="px-4 py-3 text-sm text-gray-700">₹{m.wac.toFixed(2)}</td><td className="px-4 py-3 text-sm text-center w-16"><button onClick={() => triggerDelete(m.id, 'materials', m.name)} className="text-red-500 hover:text-red-700 p-1 rounded hover:bg-red-100 transition" title={`Delete material: ${m.name}`}>🗑️</button></td></tr>)}</tbody></table></div></div>; };
    const CustomersView = () => { /* ... (View implementation omitted for brevity) ... */ return <div><div className="flex justify-between items-center mb-4"><h2 className="text-xl font-semibold text-gray-700">Customer Details</h2><button onClick={() => openModal('addCustomer')} className="bg-indigo-600 text-white text-sm px-3 py-1.5 rounded-md shadow-lg font-bold hover:bg-indigo-700 transition">+ Add New Customer</button></div><div className="bg-white card overflow-x-auto shadow-lg rounded-xl"><table className="min-w-full divide-y divide-gray-200"><thead className="bg-gray-50"><tr><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Customer Name</th><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Sell Value</th><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Money Received</th><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Borrowings</th><th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-16">Action</th></tr></thead><tbody className="divide-y divide-gray-200">{customers.map(c => ({...c, ...getCustomerFinancials(c.id)})).map(c => <tr key={c.id} className="border-b hover:bg-gray-50"><td className="px-4 py-3 text-sm text-indigo-600 font-medium cursor-pointer hover:underline" onClick={() => openModal('customerHistory', { customerId: c.id, customerName: c.name })}>{c.name}</td><td className="px-4 py-3 text-sm text-gray-700">₹{c.sellValue.toFixed(2)}</td><td className="px-4 py-3 text-sm text-green-600">₹{c.actualValue.toFixed(2)}</td><td className={`px-4 py-3 text-sm font-medium ${c.borrowings > 0 ? 'text-red-600' : 'text-green-600'}`}>₹{c.borrowings.toFixed(2)}</td><td className="px-4 py-3 text-sm text-center w-16"><button onClick={() => triggerDelete(c.id, 'customers', c.name)} className="text-red-500 hover:text-red-700 p-1 rounded hover:bg-red-100 transition" title={`Delete customer: ${c.name}`}>🗑️</button></td></tr>)}</tbody></table></div></div>; };
    const CRView = () => { /* ... (View implementation omitted for brevity) ... */ return <div className="bg-white card p-6 space-y-6 shadow-lg rounded-xl"><div  className="flex justify-between items-center mb-4"><h2 className="text-xl font-semibold text-gray-700">Credit Reconciliation</h2><button onClick={() => openModal('addCR')}className="bg-green-500 text-white text-sm px-3 py-1.5 rounded-md shadow-lg font-bold hover:bg-green-600 transition">Recieved</button></div><ul className="space-y-3">{customers.map(c => ({...c, borrowings: getCustomerFinancials(c.id).borrowings})).filter(c => c.borrowings > 0).map(c => (<li key={c.id} className="p-3 border border-red-300 rounded-md flex justify-between items-center bg-red-50"><span className="font-medium text-gray-800">{c.name}</span><span className="text-red-600 font-semibold">₹{c.borrowings.toFixed(2)}</span></li>))}</ul></div>; };
    const ExpensesView = () => { /* ... (View implementation omitted for brevity) ... */ 
    const total = operatingExpenses.reduce((sum, e) => sum + parseFloat(e.amount || 0), 0); 
    
    return (
        <div>
            <div className="flex justify-between items-center mb-4">
                <h2 className="text-xl font-semibold text-gray-700">All Expense [ Op & Pe ]</h2>
                <button onClick={() => openModal('addExpense')} className="bg-yellow-600 text-white text-sm px-3 py-1.5 rounded-md shadow-lg font-bold hover:bg-yellow-700 transition">+ Record Expense</button>
            </div>
             <div className="bg-white card overflow-x-auto shadow-lg rounded-xl">
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                        <tr>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Description</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Amount</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                            <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-16">Action</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                        {operatingExpenses.map(e => {
                            const isPersonal = e.expense_type === 'Personal'; 
                            const rowClass = isPersonal ? 'bg-yellow-50 border-b-2 border-yellow-300 hover:bg-yellow-100' : 'border-b hover:bg-gray-50'; 
                            const descriptionText = e.description; 
                            
                            return (
                                <tr key={e.id} className={rowClass}>
                                    <td className="px-4 py-3 text-sm text-gray-700">
                                        {e.timestamp?.toDate().toLocaleDateString() || new Date(e.date).toLocaleDateString() || 'N/A'}
                                    </td>
                                    <td className="px-4 py-3 text-sm text-gray-700">{descriptionText || '-'}</td>
                                    <td className="px-4 py-3 text-sm text-red-600 font-medium">₹{parseFloat(e.amount || 0).toFixed(2)}</td>
                                    <td className={`px-4 py-3 text-sm font-medium ${isPersonal ? 'text-yellow-700' : 'text-indigo-600'}`}>{e.expense_type || 'Operative'}</td>
                                    <td className="px-4 py-3 text-sm text-center w-16">
                                        <button 
                                            onClick={() => triggerDelete(e.id, 'expenses', `${e.description} (₹${parseFloat(e.amount || 0).toFixed(2)})`)} 
                                            className="text-red-500 hover:text-red-700 p-1 rounded hover:bg-red-100 transition" 
                                            title={`Delete expense: ${e.description}`}
                                        >
                                            🗑️
                                        </button>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
};
  //  const HistoryView = () => { /* ... (View implementation omitted for brevity) ... */ return <div><h2 className="text-xl font-semibold text-gray-700 mb-4">Transaction History</h2><div className="bg-white card overflow-x-auto shadow-lg rounded-xl"><table className="min-w-full divide-y divide-gray-200"><thead className="bg-gray-50"><tr><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Material</th><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Customer</th><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Quantity</th><th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Value</th><th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-16">Action</th></tr></thead><tbody className="divide-y divide-gray-200">{history.map(t => <tr key={t.id} className="border-b hover:bg-gray-50"><td className={`px-4 py-3 text-sm font-medium ${t.transaction_type === 'CR' ? 'text-green-600' : (t.transaction_type === 'DB' ? 'text-red-600' : 'text-blue-600')}`}>{t.transaction_type || '-'}</td><td className="px-4 py-3 text-sm text-gray-700">{t.timestamp?.toDate().toLocaleDateString() || 'N/A'}</td><td className="px-4 py-3 text-sm text-gray-700">{t.material ? getMaterialName(t.material) : '-'}</td><td className="px-4 py-3 text-sm text-gray-700">{t.customer ? getCustomerName(t.customer) : '-'}</td><td className="px-4 py-3 text-sm text-gray-700">{parseFloat(t.quantity || 0).toFixed(2)}</td><td className="px-4 py-3 text-sm text-gray-700">₹{parseFloat(t.total_price || 0).toFixed(2)}</td><td className="px-4 py-3 text-sm text-center w-16"><button onClick={() => triggerDelete(t.id, 'transactions', `${t.transaction_type || 'TX'} of ${parseFloat(t.quantity || 0).toFixed(2)}`)} className="text-red-500 hover:text-red-700 p-1 rounded hover:bg-red-100 transition" title="Delete Transaction">🗑️</button></td></tr>)}</tbody></table></div></div>; };

    const HistoryView = () => {
        const [sortConfig, setSortConfig] = useState({ column: 'timestamp', direction: 'desc' });
        
        const handleSort = useCallback((column) => {
            setSortConfig(prev => {
                let direction = 'asc';
                if (prev.column === column && prev.direction === 'asc') {
                    direction = 'desc';
                }
                return { column, direction };
            });
        }, []);
        
        const sortedHistory = useMemo(() => {
            let sortableItems = [...history]; 
            const { column, direction } = sortConfig;
            
            if (column) {
                sortableItems.sort((a, b) => {
                    let aValue;
                    let bValue;
                    let comparison = 0;
    
                    switch (column) {
                        case 'timestamp':
                            // Use a safe way to get the time, defaulting to 0 for invalid dates
                            const aDate = a.timestamp?.toDate();
                            const bDate = b.timestamp?.toDate();
                            aValue = (aDate instanceof Date && !isNaN(aDate.getTime())) ? aDate.getTime() : 0;
                            bValue = (bDate instanceof Date && !isNaN(bDate.getTime())) ? bDate.getTime() : 0;
                            
                            // Robust comparison for numbers
                            comparison = aValue > bValue ? 1 : (aValue < bValue ? -1 : 0);
                            break;
                        case 'quantity':
                            aValue = parseFloat(a.quantity || 0);
                            bValue = parseFloat(b.quantity || 0);
                            // Robust comparison for numbers
                            comparison = aValue > bValue ? 1 : (aValue < bValue ? -1 : 0);
                            break;
                        case 'material':
                            aValue = getMaterialName(a.material);
                            bValue = getMaterialName(b.material);
                            comparison = aValue.localeCompare(bValue);
                            break;
                        case 'customer':
                            aValue = getCustomerName(a.customer);
                            bValue = getCustomerName(b.customer);
                            comparison = aValue.localeCompare(bValue);
                            break;
                        case 'value':
                            aValue = parseFloat(a.total_price || 0);
                            bValue = parseFloat(b.total_price || 0);
                            // Robust comparison for numbers
                            comparison = aValue > bValue ? 1 : (aValue < bValue ? -1 : 0);
                            break;
                        case 'type':
                        default:
                            aValue = a.transaction_type || '';
                            bValue = b.transaction_type || '';
                            comparison = aValue.localeCompare(bValue);
                            break;
                    }
    
                    return direction === 'asc' ? comparison : -comparison;
                });
            }
            return sortableItems;
        }, [history, sortConfig, getMaterialName, getCustomerName]);


        const SortableHeader = ({ sortKey, label }) => (
            <th 
                className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:text-indigo-600 transition duration-150"
                onClick={() => handleSort(sortKey)}
            >
                <div className="flex items-center space-x-1">
                    <span>{label}</span>
                    {sortConfig.column === sortKey && (
                        <span className="text-sm">
                            {sortConfig.direction === 'asc' ? '▲' : '▼'}
                        </span>
                    )}
                </div>
            </th>
        );

        const historyRows = sortedHistory.map(t => {
            // ** CRITICAL SAFETIES ADDED HERE **
            try {
                const typeColor = t.transaction_type === 'CR' ? 'text-green-600' : (t.transaction_type === 'DB' ? 'text-red-600' : 'text-blue-600');
                const materialName = t.material ? getMaterialName(t.material) : '-';
                const customerName = t.customer ? getCustomerName(t.customer) : '-';
                const value = parseFloat(t.total_price || 0); 
                const quantity = parseFloat(t.quantity || 0);
                const quantityText = quantity > 0 ? quantity.toFixed(2) : '-';
                
                const date = t.timestamp?.toDate();
                const dateText = (date instanceof Date && !isNaN(date.getTime())) ? date.toLocaleDateString() : 'N/A';
                
                const transactionName = `${t.transaction_type || 'TX'} of ${quantity > 0 ? quantity + 'x ' : ''}${materialName}`.trim();


                return (
                    // Using t.id as the key is critical for React rendering
                    <tr key={t.id} className="border-b hover:bg-gray-50">
                        <td className={`px-4 py-3 text-sm font-medium ${typeColor}`}>{t.transaction_type || '-'}</td>
                        <td className="px-4 py-3 text-sm text-gray-700">{dateText}</td>
                        <td className="px-4 py-3 text-sm text-gray-700">{materialName}</td>
                        <td className="px-4 py-3 text-sm text-gray-700">{customerName}</td>
                        <td className="px-4 py-3 text-sm text-gray-700">{quantityText}</td>
                        <td className="px-4 py-3 text-sm text-gray-700">₹{value.toFixed(2)}</td>
                        {/* ADDED DELETE BUTTON */}
                        <td className="px-4 py-3 text-sm text-center w-16">
                            <button 
                                onClick={() => triggerDelete(t.id, 'transactions', transactionName)}
                                className="text-red-500 hover:text-red-700 p-1 rounded hover:bg-red-100 transition"
                                title={`Delete transaction: ${transactionName}`}
                            >
                                🗑️
                            </button>
                        </td>
                    </tr>
                );
            } catch (e) {
                // Log the failure point and render a placeholder row instead of crashing the whole table
                console.error("[Rendering Error] Failed to render transaction row:", t, e);
                return (
                    <tr key={`error-${t.id || t.pk || Math.random()}`} className="bg-red-50 border-b">
                        <td colSpan="7" className="px-4 py-3 text-sm text-red-700 italic">
                            [Rendering Error] Could not display transaction ID: {t.id || 'N/A'}. Check console for details.
                        </td>
                    </tr>
                );
            }
        });

        return (
            <div>
                <h2 className="text-xl font-semibold text-gray-700
                mb-4">Transaction History [sales & Purchase]</h2>
                <div className="bg-white card overflow-x-auto shadow-lg rounded-xl">
                    <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                            <tr>
                                <SortableHeader sortKey="type" label="Type" />
                                <SortableHeader sortKey="timestamp" label="Date" />
                                <SortableHeader sortKey="material" label="Material" />
                                <SortableHeader sortKey="customer" label="Customer" />
                                <SortableHeader sortKey="quantity" label="Quantity" />
                                <SortableHeader sortKey="value" label="Value" />
                                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-16">Action</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                            {historyRows.length > 0 ? historyRows : <tr><td colSpan="7" className="text-center py-6 text-gray-500">No transactions recorded yet.</td></tr>}
                        </tbody>
                    </table>
                </div>
            </div>
        );
    };


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
            <script src="https://cdn.tailwindcss.com"></script>
            <div id="app-container" className="max-w-4xl mx-auto p-4 md:p-6 pb-20">
                {isAuthenticated && (
                <div className="flex justify-between items-center mb-6 border-b pb-4">
                    {user && <h2 className="text-2xl font-semibold
                    text-indigo-600">Hello {user.username}</h2>}
                    
                    <div className="space-x-2">
                        <button onClick={handleLogout} className="bg-gray-500 text-white text-sm px-3 py-1.5 rounded-md shadow-lg font-bold hover:bg-gray-600 transition">
                            Logout
                        </button>
                    </div>
                </div>)}
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
                    {/* The new modal for displaying history */}
                    <CustomerHistoryModal /> 
                </>
            )}
            
        </div>
    );
};

export default App;
