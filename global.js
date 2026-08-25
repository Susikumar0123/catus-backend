const API_BASE_URL = window.location.hostname === 'localhost' 
    ? 'http://localhost:3000' 
    : 'https://catus-backend-d2js.onrender.com';

// ==========================================
// 1. GLOBAL VARIABLES
// ==========================================
let cartItems = JSON.parse(localStorage.getItem('catus_cart')) || [];
let discountAmount = parseInt(localStorage.getItem('catus_checkout_discount')) || 0;
let appliedCoupon = "";
let currentUser = JSON.parse(localStorage.getItem('catus_logged_user')) || null;
let tempPhone = "";
let checkoutMode = 'single'; 
let checkoutSingleItem = null;
let orderPollingInterval = null; // Clean polling timer reference

// ==========================================
// 2. UTILITY & TOAST FUNCTIONS
// ==========================================
function showToast(message, isAlreadyAdded) {
    const toast = document.getElementById('toastNotification');
    const toastMsg = document.getElementById('toastMsg');
    const toastIcon = document.getElementById('toastIcon');
    
    if(!toast) return;

    toastMsg.textContent = message;
    
    if (isAlreadyAdded) {
        toast.style.background = "#f59e0b"; 
        toastIcon.className = "fa-solid fa-circle-exclamation";
    } else {
        toast.style.background = "#10b981"; 
        toastIcon.className = "fa-solid fa-circle-check";
    }

    toast.classList.add('show');
    if (window.toastTimeout) clearTimeout(window.toastTimeout);
    window.toastTimeout = setTimeout(() => {
        toast.classList.remove('show');
    }, 2500);
}

function checkCloseModal(event, drawerId, modalId) {
    const drawer = document.getElementById(drawerId);
    const modal = document.getElementById(modalId);
    if (drawer && !drawer.contains(event.target)) {
        modal.style.display = 'none';
    }
}

// ==========================================
// 3. CART MANAGEMENT
// ==========================================
function toggleCartModal(open) { 
    const modal = document.getElementById('cartModal');
    if (modal) modal.style.display = open ? 'flex' : 'none';
    if (open) updateCartUI();
}

function updateCartUI() {
    let rawCart = localStorage.getItem('catus_cart');
    cartItems = rawCart ? JSON.parse(rawCart) : [];

    const container = document.getElementById('cartItemsList');
    const badge = document.querySelector('.cart-badge');
    const totalPriceEl = document.getElementById('cartTotalPrice');
    
    if (badge) badge.textContent = cartItems.length;
    if (!container) return;

    container.innerHTML = '';
    let subtotal = 0;

    if (cartItems.length === 0) {
        container.innerHTML = `<div style="text-align: center; color: #64748b; padding: 40px 0; font-size: 13px;">Your cart is empty!</div>`;
    } else {
        cartItems.forEach((item) => {
    let itemTotal = Math.round(parseFloat(item.price)) * (item.quantity || 1);
    subtotal += itemTotal;
            
            container.innerHTML += `
                <div class="cart-item-row">
                    <img src="${item.image || item.img || 'https://images.unsplash.com/photo-1540932239986-30128078f3c5?auto=format&fit=crop&w=150&q=80'}" class="cart-item-img">
                    <div class="cart-item-info">
                        <strong>${item.name}</strong>
                        <span>Qty: ${item.quantity || 1}</span>
                    </div>
                    <div class="cart-item-price">₹${itemTotal}</div>
                    <button class="remove-item-btn" onclick="removeFromCart('${item.name}')"><i class="fa-solid fa-trash"></i></button>
                </div>
            `;
        });
    }

    let finalTotal = subtotal - discountAmount;
    if (finalTotal < 0) finalTotal = 0;
    if (totalPriceEl) totalPriceEl.textContent = "₹" + finalTotal;
}

function addToCart(productName, productPrice, productImage, buttonElement) {
    let existingItem = cartItems.find(item => item.name.toLowerCase() === productName.toLowerCase());
    
    if (existingItem) {
        showToast(`"${productName}" is already in your cart!`, true);
        return;
    }

    cartItems.push({ name: productName, price: productPrice, image: productImage, quantity: 1 });
    localStorage.setItem('catus_cart', JSON.stringify(cartItems));
    updateCartUI();
    
    if(buttonElement) {
        buttonElement.innerHTML = '<i class="fa-solid fa-check"></i> Added';
        buttonElement.style.background = "linear-gradient(135deg, #10b981 0%, #059669 100%)";
        buttonElement.style.color = "#ffffff";
    }

    showToast(`"${productName}" Added Successfully!`, false);
}

function removeFromCart(productName) {
    cartItems = cartItems.filter(item => item.name !== productName);
    localStorage.setItem('catus_cart', JSON.stringify(cartItems));
    updateCartUI();
    
    document.querySelectorAll('.uc-card').forEach(card => {
        const titleElem = card.querySelector('h4');
        if (titleElem && titleElem.textContent.toLowerCase() === productName.toLowerCase()) {
            const btn = card.querySelector('.uc-cart-btn');
            if(btn) {
                btn.textContent = "Add to Cart";
                btn.style.background = ""; 
            }
        }
    });

    let mainTitle = document.getElementById('prodTitle');
    if (mainTitle && mainTitle.textContent.toLowerCase() === productName.toLowerCase()) {
        let mainBtn = document.getElementById('addToCartBtn');
        if(mainBtn) {
            mainBtn.innerHTML = '<i class="fa-solid fa-cart-shopping"></i> Add to Cart';
            mainBtn.style.background = "";
        }
    }
}

function clearCart() { 
    cartItems = []; 
    localStorage.removeItem('catus_cart'); 
    removeCoupon(); 
    updateCartUI(); 

    document.querySelectorAll('.uc-cart-btn').forEach(btn => {
        btn.innerHTML = '<i class="fa-solid fa-cart-shopping"></i> Add to Cart';
        btn.style.background = ""; 
    });

    let mainBtn = document.getElementById('addToCartBtn');
    if(mainBtn) {
        mainBtn.innerHTML = '<i class="fa-solid fa-cart-shopping"></i> Add to Cart';
        mainBtn.style.background = "";
    }

    showToast("Cart has been cleared!", true); 
}

function openCheckoutCart() {
    if (!currentUser) {
        alert("Please login first to place an order!");
        toggleCartModal(false);
        handleHeaderAuthClick();
        return;
    }
    if (cartItems.length === 0) {
        alert("Your cart is empty!");
        return;
    }

    localStorage.setItem('catus_checkout_items', JSON.stringify(cartItems));
    localStorage.setItem('catus_checkout_discount', discountAmount);
    localStorage.setItem('catus_checkout_mode', 'cart');

    window.location.href = 'checkout.html';
}

// ==========================================
// 4. COUPON LOGIC
// ==========================================
function applyQuickCoupon(code) {
    document.getElementById('couponInput').value = code;
    applyCoupon();
}

function applyCoupon() {
    const inputEl = document.getElementById('couponInput');
    const inputVal = inputEl.value.trim().toUpperCase();
    const msgBox = document.getElementById('couponMessage');
    const applyBtn = document.getElementById('applyBtn');

    if (inputVal === "CATUS100" || inputVal === "MAXEL100") {
        discountAmount = 100;
        appliedCoupon = inputVal;
        msgBox.style.color = "#16a34a";
        msgBox.innerHTML = `<span><i class="fa-solid fa-circle-check"></i> Coupon applied! (₹100 OFF)</span> <span style="color:#ef4444; cursor:pointer;" onclick="removeCoupon(event)"><i class="fa-solid fa-xmark"></i> Remove</span>`;
        applyBtn.disabled = true; inputEl.disabled = true;
    } else if (inputVal === "CATUS500" || inputVal === "MAXEL500") {
        discountAmount = 500;
        appliedCoupon = inputVal;
        msgBox.style.color = "#16a34a";
        msgBox.innerHTML = `<span><i class="fa-solid fa-circle-check"></i> Coupon applied! (₹500 OFF)</span> <span style="color:#ef4444; cursor:pointer;" onclick="removeCoupon(event)"><i class="fa-solid fa-xmark"></i> Remove</span>`;
        applyBtn.disabled = true; inputEl.disabled = true;
    } else if (inputVal !== "") {
        discountAmount = 0;
        appliedCoupon = "";
        msgBox.style.color = "#ef4444";
        msgBox.innerHTML = `<span><i class="fa-solid fa-circle-exclamation"></i> Invalid coupon code.</span>`;
    }
    updateCartUI();
}

function removeCoupon(event) {
    if(event) event.stopPropagation(); 
    
    discountAmount = 0;
    appliedCoupon = "";
    
    const inputEl = document.getElementById('couponInput');
    const msgBox = document.getElementById('couponMessage');
    const applyBtn = document.getElementById('applyBtn');
    
    if(inputEl) { inputEl.value = ""; inputEl.disabled = false; }
    if(msgBox) msgBox.innerHTML = "";
    if(applyBtn) applyBtn.disabled = false; 
    
    updateCartUI();
    showToast("Coupon Removed", false);
}

// ==========================================
// 5. AUTHENTICATION (LOGIN / REGISTER)
// ==========================================
function updateHeaderLoginUI() {
    const loginBtnText = document.getElementById('loginBtnText');
    if(!loginBtnText) return;

    if (currentUser && currentUser.name) {
        loginBtnText.textContent = currentUser.name.split(' ')[0];
    } else if (currentUser) {
        loginBtnText.textContent = 'Dashboard';
    } else {
        loginBtnText.textContent = 'Login';
    }
}

function handleHeaderAuthClick() {
    if (currentUser) {
        openPremiumDashboard();
    } else {
        showAuthStep('phone');
        toggleAuthModal(true);
    }
}

function toggleAuthModal(open) {
    const modal = document.getElementById('authModal');
    if (modal) modal.style.display = open ? 'flex' : 'none';
}

function showAuthStep(step) {
    document.getElementById('authStepPhone').style.display = (step === 'phone') ? 'flex' : 'none';
    document.getElementById('authStepOTP').style.display = (step === 'otp') ? 'flex' : 'none';
    document.getElementById('authStepRegister').style.display = (step === 'register') ? 'flex' : 'none';
}

function backToPhoneStep() {
    showAuthStep('phone');
}

function logoutUser() {
    if(confirm("Are you sure you want to logout securely?")) {
        if (orderPollingInterval) {
            clearInterval(orderPollingInterval);
            orderPollingInterval = null;
        }
        localStorage.removeItem('catus_logged_user');
        currentUser = null;
        closePremiumDashboard();
        updateHeaderLoginUI();
        showToast("Logged out successfully!", false);
        window.location.reload(); 
    }
}

async function requestOTP() {
    const phone = document.getElementById('inputPhone').value.trim();
    if (phone.length !== 10) {
        alert('Please enter a valid 10-digit mobile number.');
        return;
    }
    tempPhone = phone;
    
    try {
        // First check if user exists in database
        const loginRes = await fetch(`${API_BASE_URL}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: tempPhone })
        });
        const loginData = await loginRes.json();

        if (loginData.success) {
            if (loginData.exists) {
                currentUser = loginData.user;
                if(currentUser.wallet === undefined) currentUser.wallet = 2500;
            }

            // Now trigger REAL SMS OTP via Fast2SMS backend route
            const smsRes = await fetch(`${API_BASE_URL}/api/send-otp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: tempPhone })
            });
            const smsData = await smsRes.json();

            if (smsData.success) {
                showAuthStep('otp');
                document.getElementById('otpInfoText').textContent = `OTP sent via SMS to +91 ${tempPhone}`;
                showToast("OTP sent successfully to your mobile!", false);
            } else {
                alert(smsData.message || 'Failed to send real SMS OTP.');
            }
        }
    } catch (err) {
        alert('Server connection error. Make sure backend is running.');
        console.error(err);
    }
}

async function verifyOTP() {
    const otp = document.getElementById('inputOTP').value.trim();
    if (otp.length !== 4) {
        alert('Please enter the 4-digit OTP received via SMS.');
        return;
    }

    try {
        // Backend-oda real OTP verify route-ai call panrom
        const response = await fetch(`${API_BASE_URL}/api/verify-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: tempPhone, otp: otp })
        });
        const data = await response.json();

        if (data.success) {
            // User database-la illana registration step-kku anuppum
            if (!currentUser) {
                showAuthStep('register');
                showToast("OTP Verified! Please complete registration.", false);
                return;
            }

            localStorage.setItem('catus_logged_user', JSON.stringify(currentUser));
            updateHeaderLoginUI();
            toggleAuthModal(false);
            openPremiumDashboard();
            showToast("Login Successful!", false);
            
            if (orderPollingInterval) clearInterval(orderPollingInterval);
            orderPollingInterval = setInterval(() => fetchUserOrdersPremium(currentUser.phone), 5000);
        } else {
            alert(data.message || 'Invalid or expired OTP. Please try again.');
        }
    } catch (err) {
        alert('Server connection error during OTP verification.');
        console.error(err);
    }
}

async function submitRegistration() {
    const name = document.getElementById('regName').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const pincode = document.getElementById('regPincode').value.trim();
    
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!name) {
        alert('Please enter your full name.');
        return;
    }
    if (!email || !emailPattern.test(email)) {
        alert('Please enter a valid email address (e.g., name@gmail.com).');
        document.getElementById('regEmail').focus();
        return;
    }
    if (!pincode || pincode.length !== 6) {
        alert('Please enter a valid 6-digit Service Pincode.');
        document.getElementById('regPincode').focus();
        return;
    }

    const address = "No address saved";

    try {
        const response = await fetch(`${API_BASE_URL}/api/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, phone: tempPhone, pincode, address })
        });
        const data = await response.json();

        if (data.success) {
            currentUser = data.user;
            if(currentUser.wallet === undefined) currentUser.wallet = 2500;
            localStorage.setItem('catus_logged_user', JSON.stringify(currentUser));
            updateHeaderLoginUI();
            toggleAuthModal(false);
            openPremiumDashboard();
            showToast("Account Registered Successfully!", false);
            
            if (orderPollingInterval) clearInterval(orderPollingInterval);
            orderPollingInterval = setInterval(() => fetchUserOrdersPremium(currentUser.phone), 5000);
        } else {
            alert(data.message || 'Registration failed.');
        }
    } catch (err) {
        alert('Server connection error.');
        console.error(err);
    }
}

// ==========================================
// 6. CUSTOMER DASHBOARD
// ==========================================
function openPremiumDashboard() {
        toggleAuthModal(false);
        if (currentUser) {
            document.getElementById('greetName').innerHTML = "👋 Welcome, " + (currentUser.name || "Customer");
            document.getElementById('premProfileNameDisplay').textContent = currentUser.name || "Add Name";
            document.getElementById('premProfilePhone').textContent = "+91 " + currentUser.phone;
            
            let phoneDigits = String(currentUser.phone || '40001').replace(/[^0-9]/g, '');
            let displayCustId = 40000 + parseInt(phoneDigits.slice(-4));
            document.getElementById('headerCustomerId').innerHTML = "Cust ID: #" + displayCustId;
            
            let addrDisp = document.getElementById('premProfileAddressDisplay');
            if(addrDisp) addrDisp.textContent = currentUser.address || "No address saved";
            
            let emailDisp = document.getElementById('premProfileEmailDisplay');
            if(emailDisp) emailDisp.textContent = currentUser.email || "Add email";
            
            if(currentUser.wallet === undefined) currentUser.wallet = 2500;
            fetchUserOrdersPremium(currentUser.phone);
            renderAuditLogs();
        }
        document.getElementById('premiumCustomerDashboard').style.display = 'flex';
        document.body.style.overflow = 'hidden';
    }

function closePremiumDashboard() {
    document.getElementById('premiumCustomerDashboard').style.display = 'none';
    document.body.style.overflow = 'auto';
}

function switchDashTab(tabId, element) {
    document.querySelectorAll('.prem-tab-pane').forEach(tab => tab.classList.remove('active'));
    let tabTarget = 'dashTab' + tabId.charAt(0).toUpperCase() + tabId.slice(1);
    document.getElementById(tabTarget).classList.add('active');

    document.querySelectorAll('.prem-menu-item').forEach(item => item.classList.remove('active'));
    document.querySelectorAll('.prem-nav-btn').forEach(item => item.classList.remove('active'));
    
    if(element) element.classList.add('active');
    document.getElementById('dashContentArea').scrollTo({ top: 0, behavior: 'smooth' });
}

function showSummaryDetail(type) {
    const box = document.getElementById('summaryDetailBox');
    const title = document.getElementById('summaryDetailTitle');
    const textContainer = document.getElementById('summaryDetailText');
    
    if(!box) return;

    box.style.display = 'block';
    let orders = window.currentOrders || [];
    let html = '';
    
    if(type === 'bookings') {
        title.innerHTML = "<i class='fa-solid fa-list'></i> Total Bookings (" + orders.length + ")";
        orders.forEach(o => { html += `<div style='border-bottom:1px solid #e2e8f0; padding:6px 0; font-size:12px; display:flex; justify-content:space-between;'><span>${o.service_name}</span><b>${o.status}</b></div>`; });
        if(!orders.length) html = "<span style='color:#64748b;'>No bookings found.</span>";
    } else if(type === 'completed') {
        let comp = orders.filter(o => o.status.toLowerCase() === 'completed');
        title.innerHTML = "<i class='fa-solid fa-check-circle'></i> Completed Services (" + comp.length + ")";
        comp.forEach(o => { html += `<div style='border-bottom:1px solid #e2e8f0; padding:6px 0; font-size:12px; display:flex; justify-content:space-between;'><span>${o.service_name}</span><b style='color:#16a34a;'>${o.status}</b></div>`; });
        if(!comp.length) html = "<span style='color:#64748b;'>No completed services yet.</span>";
    } else if(type === 'progress') {
        let prog = orders.filter(o => o.status.toLowerCase() !== 'completed' && o.status.toLowerCase() !== 'trash' && o.status.toLowerCase() !== 'cancelled' && o.status.toLowerCase() !== 'rejected');
        title.innerHTML = "<i class='fa-solid fa-clock'></i> In Progress (" + prog.length + ")";
        prog.forEach(o => { html += `<div style='border-bottom:1px solid #e2e8f0; padding:6px 0; font-size:12px; display:flex; justify-content:space-between;'><span>${o.service_name}</span><b style='color:#f59e0b;'>${o.status}</b></div>`; });
        if(!prog.length) html = "<span style='color:#64748b;'>No active services.</span>";
    } else if(type === 'rejected') {
        let rej = orders.filter(o => o.status.toLowerCase() === 'cancelled' || o.status.toLowerCase() === 'rejected');
        title.innerHTML = "<i class='fa-solid fa-xmark-circle' style='color:#ef4444;'></i> Rejected Bookings (" + rej.length + ")";
        rej.forEach(o => { html += `<div style='border-bottom:1px solid #e2e8f0; padding:6px 0; font-size:12px; display:flex; justify-content:space-between;'><span>${o.service_name}</span><b style='color:#ef4444;'>${o.status}</b></div>`; });
        if(!rej.length) html = "<span style='color:#64748b;'>No rejected bookings found.</span>";
    }
    textContainer.innerHTML = html;
}

// Profile Edit & Audit Tracking logic
function toggleEditField(field) {
    const displayEl = document.getElementById('premProfile' + field + 'Display');
    const editEl = document.getElementById('premProfile' + field + 'Edit');
    const btn = document.getElementById('edit' + field + 'Btn');

    if (editEl.style.display === 'none') {
        editEl.value = (displayEl.innerText !== 'No address saved' && displayEl.innerText !== 'Add email') ? displayEl.innerText : '';
        displayEl.style.display = 'none';
        editEl.style.display = 'block';
        btn.innerHTML = '<i class="fa-solid fa-check"></i> Save';
        btn.style.background = '#10b981';
        btn.style.color = 'white';
        editEl.focus();
    } else {
        const oldVal = displayEl.innerText;
        const newVal = editEl.value.trim();
        
        if (newVal && newVal !== oldVal) {
            trackProfileChange(field, oldVal, newVal);
            displayEl.innerText = newVal;
            
            if(currentUser) {
                if(field === 'Name') {
                    currentUser.name = newVal;
                    document.getElementById('greetName').innerHTML = "👋 Welcome, " + newVal;
                    document.getElementById('premAvatarInitials').textContent = newVal.charAt(0).toUpperCase();
                }
                if(field === 'Address') currentUser.address = newVal;
                if(field === 'Email') currentUser.email = newVal;
                localStorage.setItem('catus_logged_user', JSON.stringify(currentUser));
                updateHeaderLoginUI();
            }
        } else if (!newVal) {
            displayEl.innerText = oldVal;
        }

        displayEl.style.display = 'block';
        editEl.style.display = 'none';
        btn.innerHTML = (field === 'Name') ? 'Edit Name' : 'Edit';
        btn.style.background = '#eff6ff';
        btn.style.color = '#0284c7';
    }
}

function toggleProfileAddressEdit() {
    const displayEl = document.getElementById('premProfileAddressDisplay');
    const editArea = document.getElementById('premProfileAddressEditArea');
    const btn = document.getElementById('editAddressBtn');

    if (editArea.style.display === 'none') {
        editArea.style.display = 'block';
        displayEl.style.display = 'none';
        btn.style.display = 'none'; 
    } else {
        editArea.style.display = 'none';
        displayEl.style.display = 'block';
        btn.style.display = 'block';
    }
}

function saveProfileAddress() {
    const door = document.getElementById('profDoor').value.trim();
    const street = document.getElementById('profStreet').value.trim();
    const village = document.getElementById('profVillage').value.trim();
    const city = document.getElementById('profCity').value.trim();
    const taluk = document.getElementById('profTaluk').value.trim();
    const district = document.getElementById('profDistrict').value.trim();
    const pincode = document.getElementById('profPincode').value.trim();

    if (!door || !village || !city || !taluk || !district || pincode.length !== 6) {
        alert("Please fill all mandatory fields and enter a valid 6-digit Pincode.");
        return;
    }

    let newAddress = `${door}, ${street ? street + ', ' : ''}${village}, ${city}, ${taluk}, ${district} - ${pincode}`;
    const oldAddress = document.getElementById('premProfileAddressDisplay').innerText;
    
    if (newAddress !== oldAddress) {
        trackProfileChange('Delivery Address', oldAddress, newAddress);
        document.getElementById('premProfileAddressDisplay').innerText = newAddress;
        
        if(currentUser) {
            currentUser.address = newAddress;
            localStorage.setItem('catus_logged_user', JSON.stringify(currentUser));
        }
    }
    
    toggleProfileAddressEdit();
    showToast("Delivery Address updated successfully!", false);
}

function trackProfileChange(field, oldVal, newVal) {
    let logs = JSON.parse(localStorage.getItem('catus_audit_logs')) || [];
    const logEntry = { 
        timestamp: new Date().toLocaleString(), 
        user: currentUser ? currentUser.phone : 'Unknown', 
        field: field, 
        oldValue: (oldVal === 'No address saved' || !oldVal) ? 'Empty' : oldVal, 
        newValue: newVal 
    };
    logs.unshift(logEntry); 
    localStorage.setItem('catus_audit_logs', JSON.stringify(logs));
    renderAuditLogs();
}

function renderAuditLogs() {
    const container = document.getElementById('auditLogContainer');
    if(!container) return;
    let logs = JSON.parse(localStorage.getItem('catus_audit_logs')) || [];
    if(logs.length === 0) {
        container.innerHTML = "No changes tracked yet.";
        return;
    }
    let html = '';
    logs.forEach(log => {
        html += `<div style="border-bottom:1px solid #e2e8f0; padding:8px 0;">
            <b style="color:#0284c7;">[${log.timestamp}]</b> User (+91 ${log.user}) changed <b>${log.field}</b> from <i>"${log.oldValue}"</i> to <i style="color:#10b981;">"${log.newValue}"</i>.
        </div>`;
    });
    container.innerHTML = html;
}

async function fetchUserOrdersPremium(phone) {
    try {
        const response = await fetch(`${API_BASE_URL}/api/orders/${phone}`);
        const data = await response.json();
        
        const ordersList = document.getElementById('premOrdersListContainer');
        if (!ordersList) return; 

        const adminCache = JSON.parse(localStorage.getItem('catusAdminCache') || '{}');
        const ratedOrders = JSON.parse(localStorage.getItem('catus_rated_orders')) || [];

        if (data.success && data.orders && data.orders.length > 0) {
            let processedOrders = data.orders.map(o => {
                let cached = adminCache[o.order_id];
                if (cached) {
                    return {
                        ...o,
                        status: cached.status || o.status,
                        technician_name: cached.name || o.technician_name,
                        technician_phone: cached.phone || o.technician_phone,
                        eta: cached.eta || o.eta,
                        address: cached.address || o.address
                    };
                }
                return o;
            });
            
            processedOrders = processedOrders.filter(o => o.status !== 'Trash');
            window.currentOrders = processedOrders; 
            
            let compCount = processedOrders.filter(o => o.status.toLowerCase() === 'completed').length;
            let activeOrders = processedOrders.filter(o => o.status.toLowerCase() !== 'completed' && o.status.toLowerCase() !== 'cancelled' && o.status.toLowerCase() !== 'rejected');
            let rejectedCount = processedOrders.filter(o => o.status.toLowerCase() === 'cancelled' || o.status.toLowerCase() === 'rejected').length;

            document.getElementById('sumTotal').textContent = processedOrders.length;
            document.getElementById('sumCompleted').textContent = compCount;
            document.getElementById('sumProgress').textContent = activeOrders.length;
            document.getElementById('sumRejected').textContent = rejectedCount;

            const liveContainer = document.getElementById('liveTrackingContainer');
            const liveTitle = document.getElementById('liveTrackingTitle');

            if(activeOrders.length > 0) {
                liveTitle.style.display = 'block';
                liveContainer.innerHTML = ''; 
                
                activeOrders.forEach(currentOrder => {
                    let stat = currentOrder.status.toLowerCase();
                    let otpCode = String(currentOrder.order_id).slice(-4) || "8421";
                    let techName = currentOrder.technician_name || "Awaiting Technician";
                    let techPhoneText = currentOrder.technician_phone ? `+91 ${currentOrder.technician_phone}` : "Assigning soon...";
                    let eta = currentOrder.eta || "-- Min";
                    
                    let orderDateObj = new Date(currentOrder.order_date);
                    let dateStringLive = orderDateObj.toLocaleDateString() + ' ' + orderDateObj.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                    let displayProductId = currentOrder.product_id || Math.floor(100 + Math.random() * 900);
                    
                    let stepBookedClass = 'prem-step-compact done';
                    let stepAssignedClass = 'prem-step-compact';
                    let stepWayClass = 'prem-step-compact';
                    let stepServiceClass = 'prem-step-compact';
                    let progressWidth = '0%';

                    let bookedStr = `<b>${orderDateObj.toLocaleDateString()}</b><br><b>${orderDateObj.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</b>`;
                    let assignedStr = "--<br>--";
                    let wayStr = "--<br>--";
                    let serviceStr = "--<br>--";

                    if(stat === 'pending') {
                        stepBookedClass = 'prem-step-compact active';
                        progressWidth = '0%';
                    } else if(stat === 'assigned') {
                        stepAssignedClass = 'prem-step-compact active';
                        progressWidth = '33.3%';
                    } else if(stat === 'on the way') {
                        stepAssignedClass = 'prem-step-compact done';
                        stepWayClass = 'prem-step-compact active';
                        progressWidth = '66.6%';
                    } else if(stat === 'in service' || stat === 'service' || stat === 'active') {
                        stepAssignedClass = 'prem-step-compact done';
                        stepWayClass = 'prem-step-compact done';
                        stepServiceClass = 'prem-step-compact active';
                        progressWidth = '75%';
                    }
                    
                    if(stat === 'assigned' || stat === 'on the way' || stat === 'in service' || stat === 'service' || stat === 'active') {
                        let aDate = new Date(orderDateObj.getTime() + 15*60000);
                        assignedStr = `<b>${aDate.toLocaleDateString()}</b><br><b>${aDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</b>`;
                    }
                    if(stat === 'on the way' || stat === 'in service' || stat === 'service' || stat === 'active') {
                        let wDate = new Date(orderDateObj.getTime() + 45*60000);
                        wayStr = `<b>${wDate.toLocaleDateString()}</b><br><b>${wDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</b>`;
                    }
                    if(stat === 'in service' || stat === 'service' || stat === 'active') {
                        let sDate = new Date(orderDateObj.getTime() + 60*60000);
                        serviceStr = `<b>${sDate.toLocaleDateString()}</b><br><b>${sDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</b>`;
                    }

                    let actionButtons = '';
                    if (stat === 'pending') {
                        actionButtons = `
                            <button class="prem-btn-compact" style="background:#eff6ff; color:#0284c7; border:1px solid #bfdbfe;" onclick="openEditOrderAddressModal('${currentOrder.order_id}', '${(currentOrder.address || '').replace(/'/g, "\\'")}')"><i class="fa-solid fa-pen-to-square"></i> Edit Address</button>
                            <button class="prem-btn-compact prem-btn-cancel-compact" onclick="openCancelModal('${currentOrder.order_id}')"><i class="fa-solid fa-xmark"></i> Cancel Booking</button>
                        `;
                    } else {
                        actionButtons = `
                            <button class="prem-btn-compact" style="background:#f1f5f9; color:#94a3b8; border:1px solid #e2e8f0; cursor:not-allowed;" title="Cannot edit address after technician is assigned" disabled><i class="fa-solid fa-pen-to-square"></i> Edit Address</button>
                            <button class="prem-btn-compact" style="background:#f1f5f9; color:#94a3b8; border:1px solid #e2e8f0; cursor:not-allowed;" title="Cannot cancel booking after technician is assigned" disabled><i class="fa-solid fa-xmark"></i> Cancel Booking</button>
                        `;
                    }

                    let cardHTML = `
                    <div class="prem-live-card">
                        <div class="prem-live-top-row">
                            <div>
                                <h3 style="margin: 0 0 4px 0; font-size: 14px; color: #0f172a;">${currentOrder.service_name}</h3>
                                <div style="font-size:10px; color:#64748b; display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin-bottom:6px;">
                                    <span><b>Order ID:</b> #${currentOrder.order_id}</span> <span style="color:#cbd5e1;">|</span>
                                    <span><b>Product ID:</b> #${displayProductId}</span> <span style="color:#cbd5e1;">|</span>
                                    <span><b>Date:</b> ${dateStringLive}</span>
                                </div>
                                <div class="prem-live-status-badge"><span class="pulse"></span> ${currentOrder.status.toUpperCase()}</div>
                            </div>
                            <div class="prem-live-otp-compact">
                                Booking OTP
                                <span>${otpCode}</span>
                            </div>
                        </div>
                        
                        <div class="prem-live-middle-row">
                            <div class="prem-tech-info-compact">
                                <img src="https://images.unsplash.com/photo-1560250097-0b93528c311a?auto=format&fit=crop&w=150&q=80" alt="Technician" class="prem-tech-img-compact">
                                <div class="prem-tech-details-compact">
                                    <h4>${techName}</h4>
                                    <p><i class="fa-solid fa-star" style="color:#f59e0b;"></i> 4.9 • ${techPhoneText}</p>
                                </div>
                            </div>
                            <div class="prem-eta-compact">
                                <strong>${eta}</strong>
                                <span>Est. Arrival</span>
                            </div>
                        </div>
                        
                        <div class="prem-timeline-compact">
                            <div class="prem-timeline-progress" style="width: ${progressWidth};"></div>
                            <div class="${stepBookedClass}">
                                <div class="prem-step-icon-compact"><i class="fa-solid fa-check"></i></div>
                                <span>Booked</span>
                                <div style="font-size:8.5px; color:#334155; text-align:center; margin-top:3px; line-height:1.2; font-weight:bold;">${bookedStr}</div>
                            </div>
                            <div class="${stepAssignedClass}">
                                <div class="prem-step-icon-compact"><i class="fa-solid fa-user-check"></i></div>
                                <span>Assigned</span>
                                <div style="font-size:8.5px; color:#334155; text-align:center; margin-top:3px; line-height:1.2; font-weight:bold;">${assignedStr}</div>
                            </div>
                            <div class="${stepWayClass}">
                                <div class="prem-step-icon-compact"><i class="fa-solid fa-motorcycle"></i></div>
                                <span>On the way</span>
                                <div style="font-size:8.5px; color:#334155; text-align:center; margin-top:3px; line-height:1.2; font-weight:bold;">${wayStr}</div>
                            </div>
                            <div class="${stepServiceClass}">
                                <div class="prem-step-icon-compact"><i class="fa-solid fa-wrench"></i></div>
                                <span>Service</span>
                                <div style="font-size:8.5px; color:#334155; text-align:center; margin-top:3px; line-height:1.2; font-weight:bold;">${serviceStr}</div>
                            </div>
                        </div>

                        <div class="prem-actions-compact">
                            ${actionButtons}
                        </div>
                    </div>
                    `;
                    liveContainer.innerHTML += cardHTML;
                });
            } else {
                liveTitle.style.display = 'none';
                liveContainer.innerHTML = '';
            }

            // Update My Bookings Tab List (History)
            ordersList.innerHTML = ''; 
            processedOrders.forEach(order => {
                let statusColor = (order.status.toLowerCase() === 'cancelled' || order.status.toLowerCase() === 'rejected') ? '#ef4444' : '#16a34a';
                let statusBg = (order.status.toLowerCase() === 'cancelled' || order.status.toLowerCase() === 'rejected') ? '#fef2f2' : '#f0fdf4';
                
                let dateString = new Date(order.order_date).toLocaleDateString() + ' ' + new Date(order.order_date).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                
                let displayProductId = order.product_id || Math.floor(100 + Math.random() * 900);
                let safeCustName = currentUser.name ? currentUser.name.replace(/'/g, "\\'") : 'Customer';
                let safeServiceName = order.service_name.replace(/'/g, "\\'");
                
                let isRated = ratedOrders.includes(String(order.order_id));
                let ratingBtnHTML = '';
                let actionButtonsHTML = '';

                if(order.status.toLowerCase() === 'completed') {
                    if (isRated) {
                        ratingBtnHTML = `<button class="prem-btn-small" style="flex:1; padding:8px; font-size:11px; background:#f1f5f9; color:#94a3b8; border-color:#e2e8f0; cursor:not-allowed;" onclick="showToast('You have already rated this service!', true)"><i class="fa-solid fa-check-circle"></i> Rated</button>`;
                    } else {
                        ratingBtnHTML = `<button class="prem-btn-small" style="flex:1; padding:8px; font-size:11px; background:#10b981; color:white; border-color:#10b981;" onclick="openRatingModal('${order.order_id}', '${safeServiceName}', '${displayProductId}')"><i class="fa-solid fa-star"></i> Rate Service</button>`;
                    }
                    actionButtonsHTML = `
                        <button class="prem-btn-small" style="flex:1; padding:8px; font-size:11px;" onclick="downloadInvoice('${order.order_id}', '${safeServiceName}', '${order.amount}', '${order.status}', '${dateString}', '${displayProductId}', '${safeCustName}', '${currentUser.phone}')"><i class="fa-solid fa-file-pdf"></i> Download PDF</button>
                        <button class="prem-btn-small" style="flex:1; padding:8px; font-size:11px; background:#eff6ff; color:#0284c7; border-color:#bfdbfe;" onclick="openInvoiceView('${order.order_id}', '${safeServiceName}', '${order.amount}', '${order.status}', '${dateString}', '${displayProductId}')"><i class="fa-solid fa-file-invoice"></i> View Invoice</button>
                        ${ratingBtnHTML}
                    `;
                } else {
                    ratingBtnHTML = `<button class="prem-btn-small" style="flex:1; padding:8px; font-size:11px; background:#f1f5f9; color:#94a3b8; border-color:#e2e8f0; cursor:not-allowed;" disabled><i class="fa-solid fa-star"></i> Rate Service</button>`;
                    actionButtonsHTML = `${ratingBtnHTML}`;
                }

                ordersList.innerHTML += `
                    <div class="prem-card-box" style="margin-bottom:10px; padding:15px; border-radius:8px; box-shadow: 0 2px 4px rgba(0,0,0,0.03);">
                        <div style="display:flex; justify-content:space-between; align-items:flex-start; border-bottom:1px solid #f1f5f9; padding-bottom:10px; margin-bottom:10px;">
                            <div style="display:flex; gap:12px;">
                                <img src="https://images.unsplash.com/photo-1540932239986-30128078f3c5?auto=format&fit=crop&w=150&q=80" style="width:45px; height:45px; border-radius:6px; object-fit:cover; border:1px solid #e2e8f0;">
                                <div>
                                    <strong style="color:#0f172a; font-size:14px; display:block; margin-bottom:6px;">${order.service_name}</strong>
                                    <div style="font-size:11px; color:#64748b; display:flex; flex-wrap:wrap; align-items:center; gap:6px;">
                                        <span><b>Order ID:</b> #${order.order_id}</span> <span style="color:#cbd5e1;">|</span>
                                        <span><b>Product ID:</b> #${displayProductId}</span> <span style="color:#cbd5e1;">|</span>
                                        <span><b>Date:</b> ${dateString}</span>
                                    </div>
                                </div>
                            </div>
                            <div style="text-align:right;">
                                <span style="background:${statusBg}; color:${statusColor}; padding:4px 8px; border-radius:4px; font-size:10px; font-weight:700;">${order.status}</span>
                                <div style="font-size:15px; font-weight:800; color:#0f172a; margin-top:8px;">₹${order.amount}</div>
                            </div>
                        </div>
                        <div style="display:flex; gap:8px;">
                            ${actionButtonsHTML}
                        </div>
                    </div>
                `;
            });
        } else {
            window.currentOrders = [];
            document.getElementById('sumTotal').textContent = "0";
            document.getElementById('sumCompleted').textContent = "0";
            document.getElementById('sumProgress').textContent = "0";
            document.getElementById('sumRejected').textContent = "0";
            ordersList.innerHTML = `<p style="color:#64748b; text-align:center; padding: 20px;">No bookings found yet.</p>`;
            document.getElementById('liveTrackingTitle').style.display = 'none';
            document.getElementById('liveTrackingContainer').innerHTML = '';
        }
    } catch (err) {
        console.error('Failed to fetch user orders', err);
    }
}

// ==========================================
// 7. ACTION MODALS (CANCEL, EDIT ADDRESS, INVOICE, RATING)
// ==========================================
let activeCancelOrderId = null;

function openCancelModal(orderId) {
    activeCancelOrderId = orderId;
    document.getElementById('cancelBookingModal').style.display = 'flex';
}

function closeCancelModal() {
    document.getElementById('cancelBookingModal').style.display = 'none';
    activeCancelOrderId = null;
}

function submitCancellation() {
    let selectedReason = document.querySelector('input[name="cancelReason"]:checked');
    if (!selectedReason) {
        alert("Please select a reason for cancellation.");
        return;
    }
    
    const adminCache = JSON.parse(localStorage.getItem('catusAdminCache') || '{}');
    adminCache[activeCancelOrderId] = { status: 'Cancelled', reason: selectedReason.value };
    localStorage.setItem('catusAdminCache', JSON.stringify(adminCache));

    alert("Booking cancelled successfully.");
    closeCancelModal();
    
    if (currentUser && currentUser.phone) {
        fetchUserOrdersPremium(currentUser.phone); 
    }
}

function openEditOrderAddressModal(orderId, currentAddress) {
    document.getElementById('editAddressOrderId').value = orderId;
    
    ['editDoor', 'editStreet', 'editVillage', 'editCity', 'editTaluk', 'editDistrict', 'editPincode'].forEach(id => {
        let el = document.getElementById(id);
        if(el) { el.value = ''; el.classList.remove('error'); }
    });
    
    let alertBox = document.getElementById('editAddressAlert');
    if(alertBox) alertBox.style.display = 'none';

    let parts = currentAddress ? currentAddress.split(',').map(s => s.trim()) : [];
    if(parts.length > 0) {
        if(parts[0]) { let el = document.getElementById('editDoor'); if(el) el.value = parts[0]; }
        if(parts[1]) { let el = document.getElementById('editStreet'); if(el) el.value = parts[1]; }
        if(parts[2]) { let el = document.getElementById('editVillage'); if(el) el.value = parts[2]; }
    }

    document.getElementById('editOrderAddressModal').style.display = 'flex';
}

function closeEditOrderAddressModal() {
    document.getElementById('editOrderAddressModal').style.display = 'none';
}

async function submitEditOrderAddress() {
    const orderId = document.getElementById('editAddressOrderId').value;
    
    let missing = false;
    ['editDoor', 'editStreet', 'editVillage', 'editCity', 'editTaluk', 'editDistrict', 'editPincode'].forEach(id => {
        let el = document.getElementById(id);
        if (el && !el.value.trim()) { 
            el.classList.add('error'); 
            missing = true; 
        } else if(el) { 
            el.classList.remove('error'); 
        }
    });

    let pinEl = document.getElementById('editPincode');
    if (pinEl && pinEl.value.trim().length !== 6) { 
        pinEl.classList.add('error'); 
        missing = true; 
    }

    if (missing) {
        let alertBox = document.getElementById('editAddressAlert');
        if(alertBox) alertBox.style.display = 'block';
        return;
    }
    
    let alertBox = document.getElementById('editAddressAlert');
    if(alertBox) alertBox.style.display = 'none';

    const door = document.getElementById('editDoor').value.trim();
    const street = document.getElementById('editStreet').value.trim();
    const village = document.getElementById('editVillage').value.trim();
    const city = document.getElementById('editCity').value.trim();
    const taluk = document.getElementById('editTaluk').value.trim();
    const district = document.getElementById('editDistrict').value.trim();
    const pincode = document.getElementById('editPincode').value.trim();

    const newAddress = `${door}, ${street ? street + ', ' : ''}${village}, ${city}, ${taluk}, ${district} - ${pincode}`;

    try {
        const response = await fetch(`${API_BASE_URL}/api/admin/update-order-address`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                order_id: orderId,
                address: newAddress,
                district: district,
                pincode: pincode
            })
        });

        const data = await response.json();
        if (data.success) {
            const adminCache = JSON.parse(localStorage.getItem('catusAdminCache') || '{}');
            if (!adminCache[orderId]) adminCache[orderId] = {};
            adminCache[orderId].address = newAddress;
            localStorage.setItem('catusAdminCache', JSON.stringify(adminCache));

            alert("Address updated successfully for this booking and synced with Admin Panel!");
            closeEditOrderAddressModal();

            if (currentUser && currentUser.phone) {
                fetchUserOrdersPremium(currentUser.phone);
            }
        } else {
            alert("Failed to update address in database.");
        }
    }   catch (err) {
        console.error("Connection error:", err);
        alert("Server connection error.");
    }
}

function openInvoiceView(orderId, serviceName, amount, status, dateStr, productId) {
    let content = document.getElementById('invoiceContent');
    if(!content) return;
    content.innerHTML = `
        <div style="display:flex; justify-content:space-between; margin-bottom:5px;"><span>Order ID:</span> <strong style="color:#0f172a;">#${orderId}</strong></div>
        <div style="display:flex; justify-content:space-between; margin-bottom:5px;"><span>Product ID:</span> <strong style="color:#0f172a;">#${productId || 'N/A'}</strong></div>
        <div style="display:flex; justify-content:space-between; margin-bottom:5px;"><span>Service:</span> <strong style="text-align:right; max-width:60%;">${serviceName}</strong></div>
        <div style="display:flex; justify-content:space-between; margin-bottom:5px;"><span>Date:</span> <strong>${dateStr}</strong></div>
        <div style="display:flex; justify-content:space-between; margin-bottom:5px;"><span>Amount Paid:</span> <strong>₹${amount}</strong></div>
        <div style="display:flex; justify-content:space-between; margin-top:10px; padding-top:10px; border-top:1px dashed #cbd5e1;"><span>Current Status:</span> <span style="background:#f0fdf4; color:#16a34a; padding:2px 8px; border-radius:4px; font-weight:bold;">${status}</span></div>
    `;
    document.getElementById('invoiceViewModal').style.display = 'flex';
}

function closeInvoiceView() {
    document.getElementById('invoiceViewModal').style.display = 'none';
}

function downloadInvoice(orderId, serviceName, amount, status, dateStr, productId, custName, custPhone) {
    let printWindow = window.open('', '_blank', 'width=800,height=600');
    let html = `
    <html>
    <head>
        <title>Invoice - #${orderId}</title>
        <style>
            body { font-family: Arial, sans-serif; padding: 30px; color: #1e293b; }
            .header { display: flex; justify-content: space-between; border-bottom: 2px solid #0284c7; padding-bottom: 15px; margin-bottom: 20px; }
            .logo { font-size: 22px; font-weight: bold; color: #0284c7; }
            .details { display: flex; justify-content: space-between; margin-bottom: 25px; font-size: 13px; }
            table { width: 100%; border-collapse: collapse; margin-top: 15px; }
            th, td { border: 1px solid #cbd5e1; padding: 12px; text-align: left; font-size: 13px; }
            th { background: #f8fafc; color: #475569; }
            .total { text-align: right; font-size: 16px; font-weight: bold; margin-top: 20px; color: #16a34a; }
        </style>
    </head>
    <body>
        <div class="header">
            <div class="logo">CATUS SERVICES</div>
            <div style="text-align: right;"><b>INVOICE</b><br>Date: ${dateStr}<br>Status: ${status}</div>
        </div>
        <div class="details">
            <div><b>Billed To:</b><br>${custName}<br>+91 ${custPhone}</div>
            <div><b>Order Details:</b><br>Order ID: #${orderId}<br>Product ID: #${productId}</div>
        </div>
        <table>
            <thead><tr><th>Service Description</th><th>Qty</th><th>Amount</th></tr></thead>
            <tbody><tr><td>${serviceName}</td><td>1</td><td>₹${amount}</td></tr></tbody>
        </table>
        <div class="total">Total Paid: ₹${amount}</div>
        <p style="text-align:center; color:#64748b; margin-top:50px; font-size:12px;">Computer generated invoice.</p>
    </body>
    </html>`;
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => { printWindow.print(); printWindow.close(); }, 500);
}

function openRatingModal(orderId, serviceName, productId) {
    document.getElementById('ratingServiceName').textContent = serviceName;
    document.getElementById('ratingReviewText').value = ""; 
    document.getElementById('currentRatingOrderId').value = orderId;
    
    let prodIdInput = document.getElementById('currentRatingProductId');
    if(!prodIdInput) {
        let input = document.createElement('input');
        input.type = 'hidden';
        input.id = 'currentRatingProductId';
        document.getElementById('ratingModal').appendChild(input);
        prodIdInput = input;
    }
    prodIdInput.value = productId || '';

    setRating(0); 
    document.getElementById('ratingModal').style.display = 'flex';
}

function closeRatingModal() {
    document.getElementById('ratingModal').style.display = 'none';
}

function setRating(val) {
    document.getElementById('currentRatingVal').value = val;
    const stars = document.getElementById('starRatingContainer').children;
    for(let i=0; i<5; i++) {
        if(i < val) {
            stars[i].style.color = '#f59e0b';
            stars[i].style.transform = 'scale(1.15)';
        } else {
            stars[i].style.color = '#cbd5e1';
            stars[i].style.transform = 'scale(1)';
        }
    }
}

async function submitServiceRating() {
    const rating = parseInt(document.getElementById('currentRatingVal').value);
    if(rating === 0) {
        alert("Please select a star rating first.");
        return;
    }
    
    const reviewText = document.getElementById('ratingReviewText').value.trim();
    const orderId = document.getElementById('currentRatingOrderId').value;
    const prodIdInput = document.getElementById('currentRatingProductId');
    
    const targetServiceId = (prodIdInput && prodIdInput.value) ? prodIdInput.value : (typeof activeServiceId !== 'undefined' ? activeServiceId : 'tv-repair');
    const customerName = currentUser ? currentUser.name : "Customer";
    
    try {
        const res = await fetch(`${API_BASE_URL}/api/reviews`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                service_id: targetServiceId,
                customer_name: customerName, 
                rating: rating, 
                review_text: reviewText 
            })
        });
        const data = await res.json();
        
        if(data.success) {
            let ratedOrders = JSON.parse(localStorage.getItem('catus_rated_orders')) || [];
            ratedOrders.push(orderId);
            localStorage.setItem('catus_rated_orders', JSON.stringify(ratedOrders));

            closeRatingModal();
            showToast("Thanks for your review & rating! It's live now.", false);
            
            if (currentUser && currentUser.phone) fetchUserOrdersPremium(currentUser.phone);
        } else {
            alert("Failed to submit review.");
        }
    } catch(e) {
        console.error("Review submission error:", e);
        alert("Server connection error.");
    }
}