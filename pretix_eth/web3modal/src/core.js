"use strict";

import {
    GlobalPretixEthState,
    getPaymentTransactionData,
    resetErrorMessage,
    showError
} from './interface.js';
import { addPendingTransactionDetails } from './transactionDetailsBuffer.js';

// TODO doc
let singleton3citiesIframeMessageEventHandler = undefined;
function createOrUpdateSingleton3citiesIframeMessageEventHandler({ tcOrigin, onTransactionSigned, onCloseIframe }) {
    if (singleton3citiesIframeMessageEventHandler) {
        window.removeEventListener('message', singleton3citiesIframeMessageEventHandler, true);
        singleton3citiesIframeMessageEventHandler = undefined;
    }

    singleton3citiesIframeMessageEventHandler = (event) => {
        if (event.origin === tcOrigin) { // WARNING this is a crucial security check to ensure that this message has been sent from the expected 3cities iframe origin. Otherwise, any window can claim to be sending a message from 3cities
            if (event !== null && typeof event === 'object' && event.data !== null && typeof event.data === 'object') {
                if (event.data.kind === 'TransactionSigned') onTransactionSigned(event.data);
                else if (event.data.kind === 'CloseIframe') onCloseIframe();
                else if (event.data.kind === 'Checkout') {
                    // no-op on Checkout event
                }
                else console.error("Unexpected kind of event from 3cities, kind=", event.data.kind);
            } else console.error("Unexpected event from 3cities", event);
        }
    };
    window.addEventListener('message', singleton3citiesIframeMessageEventHandler, true);
}

function make3citiesIframe({
    tcBaseUrl, // string. 3cities client base URL. TODO enumerate the checkout data that currently must be included in the base url vs. those supplied below as url params
    receiverAddress, // string address `0x${string}`. Receiver address to which payment will be sent.
    paymentLogicalAssetAmountInUsd, // string. 18 decimal full precision US Dollar amount due for this payment. Ie. `$1 = (10**18).toString()`
    primaryCurrency, // string. Primary logical currency in which to denominate this payment ("USD", "ETH", etc). Currency must be supported by 3cities.
    usdPerEth, // string decimal number, eg. '4012.56'. USD/ETH rate to use for this payment. 3cities has its own internal exchange rates but they may be overridden, as we are doing here.
    onTransactionSigned, // callback to invoke on 3cities TransactionSigned event. See below for signature type
}) {
    const tcIframeContainerId = "3cities-iframe-container";

    createOrUpdateSingleton3citiesIframeMessageEventHandler({
        tcOrigin: new URL(tcBaseUrl).origin,
        onTransactionSigned,
        onCloseIframe: () => { removeElementById(tcIframeContainerId); },
    })

    // TODO create a real 3cities SDK that configures these options, generates the final 3cities URL, and instantiates/styles the iframe

    // BEGIN - mock 3cities options to later be migrated to SDK
    // TODO pass ethusd exchange rate to 3cities to override 3cities' own internal exchange rate engine with the user's guaranteed rate determined internally by pretix
    // TODO set 3cities SDK receiver address from GlobalPretixEthState.paymentDetails['recipient_address'] and also support an optionally distinct receiver address per chain --> WARNING, right now, the configured receiver address in pretix-eth (ie. globalPretixEthState.paymentDetails['recipient_address']) must coincidentally be the same value as the receiver address baked into the 3cities base URL
    const requireInIframeOrErrorWith = 'Standalone page detected. Please use the "Click here to pay" pop-up in Pretix'; // require 3cities to be embedded as an iframe by way of refusing to proceed with payment unless a parent window is detected. For pretix-eth, this prevents payments from occurring in a context where the pretix web client ends up not being the parent window and thus can't receive the user's signature and transaction details via window.parent.postMessage. For example, some wallet connection libraries can cause the 3cities iframe to be opened in a new browser; instead, the user should open the pretix web app in the new browser --> TODO instead of just error msg, optionally allow a redirect URL ("You need to pay inside Pretix. Redirecting you automatically back to pretex... click here if it doesn't happen")
    const iframeParentWindowOrigin = window.location.origin; // iff defined, if 3cities calls window.parent.postMessage, then 3cities will require that the window receiving the message has this origin. In practice, this means that only this window may receive the user's signature and transaction details when 3cities calls postMessage
    const authenticateSenderAddress = { // iff this config object is defined, 3cities will ask the user for a CAIP-222-style signature to authenticate their ownership of the connected wallet address prior to checking out. This signature can then be obtained from the 3cities iframe by way of window.parent.postMessage and, in future, via webhooks and/or redirect URL params
        verifyEip1271Signature: true, // iff this is true, 3cities will attempt to detect if the user's conected address is a smart contract wallet, and if this is detected, 3cities will verify the eip1271 signature by requiring an isValidSignature call to return true before allowing payment to proceed. While this clientside call to isValidSignature is insecure from the point of view of the serverside verifier, in practice, this can help prevent a user from paying with a wallet whose ownership signature can't later be verified by the serverside verifier. If user's connected address is a counterfactually instantiated smart contract wallet, then it'll appear to be an EOA to the 3cities iframe and this verification will be skipped prior to payment. However, after payment, the serverside verifier may optionally detect this address as a smart contract wallet and verify the eip1271 signature at that point --> WARNING 3cities does not actually perform this verification yet
    };
    const clickToCloseIframeLabel = 'Return to Ticket Shop'; // If this is defined as a string, upon successful checkout, 3cities will present the user with a button to close the iframe, and this button's label will be this string value. If undefined, 3cities's default behavior upon successful checkout is to show a QR code with the payment receipt, and the user can still close the iframe by clicking the X in the corner or anywhere outside the iframe. Note that iframes can't close themselves, see CloseIframe handler here.
    const requireNativeTokenTransferProxy = true; // iff this is true, 3cities will route any native token transfers through a proxy that emits an ERC20-compliant Transfer event. This must be true for the offchain verifier to detect and successfully verify ETH payments
    // END - mock 3cities options to later be migrated to SDK

    const computedThreeCitiesUrl = (() => {
        // today, tcBaseUrl is expected to be of the form `#/?pay=...` ie. having synthetic URL parameters as part of the hash fragment. As a result, we can't use the browser URL API to append search parameters as this api isn't designed to recognize our synthetic search parameters in the hash fragment. Instead, we apply new search params using array-based string manipulation:
        const urlParts = [tcBaseUrl];
        urlParts.push(`&receiverAddress=${encodeURIComponent(receiverAddress)}`);
        urlParts.push(`&amount=${encodeURIComponent(paymentLogicalAssetAmountInUsd)}`);
        urlParts.push(`&currency=${encodeURIComponent(primaryCurrency)}`);
        urlParts.push(`&usdPerEth=${encodeURIComponent(usdPerEth)}`);
        if (requireInIframeOrErrorWith) urlParts.push(`&requireInIframeOrErrorWith=${encodeURIComponent(requireInIframeOrErrorWith)}`);
        if (iframeParentWindowOrigin) urlParts.push(`&iframeParentWindowOrigin=${encodeURIComponent(iframeParentWindowOrigin)}`)
        if (authenticateSenderAddress) {
            urlParts.push('&authenticateSenderAddress=1');
            if (authenticateSenderAddress.verifyEip1271Signature) urlParts.push('&verifyEip1271Signature=1');
        }
        if (clickToCloseIframeLabel) urlParts.push(`&clickToCloseIframeLabel=${encodeURIComponent(clickToCloseIframeLabel)}`);
        if (requireNativeTokenTransferProxy) urlParts.push('&requireNativeTokenTransferProxy=1');
        const url = urlParts.join('');
        return url;
    })();
    makeIframeModal(tcIframeContainerId, computedThreeCitiesUrl);

    function removeElementById(id) {
        const el = document.getElementById(id);
        if (el) el.remove();
    }

    function makeIframeModal(iframeContainerId, url) {
        // WARNING this unreadable code is a 1-liner generated by 3cities "HTML embed" feature and is intended to be a temporary solution for an iframe modal. TODO replace this with an iframe created internally in a real 3cities SDK
        (function () { let m = document.createElement('div'); m.id = iframeContainerId; m.style = 'position:fixed;top:0;left:0;width:100%;height:100%;background-color:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;'; m.onclick = function (e) { if (e.target === m) { removeModal(); } }; let removeModal = function () { if (document.body.contains(m)) { document.body.removeChild(m); document.removeEventListener('keydown', escListener); } }; let escListener = function (e) { if (e.key === 'Escape') { removeModal(); } }; document.addEventListener('keydown', escListener); let mc = document.createElement('div'); let maxWidth = window.innerWidth < 481 ? (window.innerWidth - 30) + 'px' : '451px' /* WARNING 3cities's responsive design breakpoint for mobile/small screens is 435px. This means that if 3cities's width is >= 435px, it'll be displayed in desktop mode. Here we set max width to 451px because 435px 3cities width + 8px padding on left/right = 451px and we want the modal pop-up to be displayed in desktop mode (on desktop) so that the UI elements specific to desktop are included in the payment UX, such as changing the colors of buttons when the mouse hovers over them */; mc.style = 'background-color:#f1f1f1;padding:8px;width:100%;max-width:' + maxWidth + ';height:95vh;max-height:1024px;border-radius:10px;position:relative;box-shadow:0 4px 6px rgba(0,0,0,0.1), 0 2px 4px rgba(0,0,0,0.06);margin:auto;'; let i = document.createElement('iframe'); i.allow = 'clipboard-write' /* allow writing to the OS clipboard inside the iframe, eg. to copy walletconnect code */; i.style = 'width:100%;height:100%;border:0;'; i.src = url; let c = document.createElement('div'); c.style = 'position:absolute;top:5px;right:5px;width:24px;height:24px;cursor:pointer;z-index:10;'; c.innerHTML = '<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 20 20\' fill=\'currentColor\' style=\'width:100%;height:100%;\'><path fill-rule=\'evenodd\' clip-rule=\'evenodd\' d=\'M10 9.293l5.146-5.147a.5.5 0 01.708.708L10.707 10l5.147 5.146a.5.5 0 01-.708.708L10 10.707l-5.146 5.147a.5.5 0 01-.708-.708L9.293 10 4.146 4.854a.5.5 0 11.708-.708L10 9.293z\'></path></svg>'; c.onclick = function () { removeModal(); }; mc.appendChild(i); mc.appendChild(c); m.appendChild(mc); document.body.appendChild(m); })();
    }
}

// TODO doc
async function makePayment() {
    async function _tryToStartPaymentFlow() {
        // refresh paymentDetails in case account has changed
        GlobalPretixEthState.paymentDetails = await getPaymentTransactionData(true);

        if (GlobalPretixEthState.paymentDetails['is_signature_submitted'] === true) {
            showError("It seems that you have paid for this order already.");
            return;
        }

        // WARNING the value 'has_other_unpaid_orders' is true iff the user's sender address has signed messages for other unpaid orders (see retrieve() in views.py). However, with 3cities, we aren't able to construct this value because the user's sender address is hidden inside the iframe (and not yet connected at this point in the payment flow). So, this check has been dropped. TODO what's the impact here? --> rm this code?
        // if (GlobalPretixEthState.paymentDetails['has_other_unpaid_orders'] === true) {
        //     showError("Please wait for other payments from your wallet to be confirmed before submitting another transaction.")
        //     return;
        // }

        make3citiesIframe({
            tcBaseUrl: `https://${GlobalPretixEthState.paymentDetails['3cities_interface_domain']}/#/pay?c=CAESFKwNd1PqKBZQG1f66a1mVzkBg4SzIgICASoCARA6DEVUSCBXRVRIIERBSUowAQoBAAoEAgEGAQoIBAUDCgUDBAMFAgoHBwcHBwcHCgUJAQQECggBBAUHCgMEBAQDWinwn6eQIEtlZXAgdGhpcyBwb3AtdXAgb3BlbiBkdXJpbmcgc2lnbmluZw`, // this is a production payment link with baked in settings: single receiver address 0x67406f6F75F3Bb2bA0DeDdf2676D3bA6F55C700F; chain allowlist: Ethereum Mainnet, OP Mainnet, Arbitrum One, Scroll, Linea, Zora, Base, Blast, Mode; TODO add zkSync Era after multi receiver address is implemented and Taiko; TODO add Polygon zkEVM after the payment bugs on it are fixed; token allowlist: ETH, WETH, DAI; TODO add USDC, USDT, LUSD, USDP, PYUSD, GUSD after legal approval; TODO add USDGLO to 3cities --> TODO pass chain/token allowlist as URL params sourced from plugin config
            receiverAddress: GlobalPretixEthState.paymentDetails['recipient_address'],
            paymentLogicalAssetAmountInUsd: GlobalPretixEthState.paymentDetails['amount'],
            primaryCurrency: GlobalPretixEthState.paymentDetails['primary_currency'],
            usdPerEth: GlobalPretixEthState.paymentDetails['usd_per_eth'],
            onTransactionSigned: scheduleTransactionDetailsForServerSubmission,
        });
    }

    resetErrorMessage();

    try {
        await _tryToStartPaymentFlow();
    } catch (error) {
        console.error('Pay flow error:', error);
        showError(error, true);
    }
}

async function scheduleTransactionDetailsForServerSubmission(transactionDetailsFrom3cities) {
    /*
    NB type of message sent from 3cities upon transaction signed:
    {
        kind: 'TransactionSigned';
        signature: `0x${string}` | `eip1271-chainId-${number}`; // a successfully collected Caip222-style signature. `0x${string}` indicates an ordinary signature. `eip1271-chainId-${number}` indicates a smart contract wallet verified the message using eip1271 verification via a isValidSignature call on the provided chainId;
        message: {
            senderAddress: `0x${string}`;
        };
        transactionHash: string;
        chainId: number;
        // ... more insecure fields for admin convenience
    }
    */

    const td = transactionDetailsFrom3cities;
    const transactionDetailsUrlSearchParams = { // WARNING this object will be passed as a literal into the URLSearchParams constructor, so all values must be compatible with URLSearchParams
        // NB `csrfmiddlewaretoken: csrf_cookie,` will be added later by submission algorithm
        senderAddress: td.caip222StyleMessageThatWasSigned.senderAddress, // we extract senderAddress and send it separately because the backend wants senderAddress as structured data but the type of `message` is opaque to the backend (ie. the backend treats its received `message` as a blob)
        signature: td.caip222StyleSignature,
        message: JSON.stringify(td.caip222StyleMessageThatWasSigned),
        transactionHash: td.transactionHash,
        chainId: td.chainId,
        tokenTicker: td.tokenTicker,
        tokenName: td.tokenName,
        tokenAmount: td.tokenAmount,
        tokenDecimals: td.tokenDecimals,
    };
    const usp = transactionDetailsUrlSearchParams;
    // Some fields may be undefined and if so should be excluded:
    if (typeof td.receiptUrl !== 'undefined') usp.receiptUrl = td.receiptUrl;
    if (typeof td.tokenCurrency !== 'undefined') usp.tokenCurrency = td.tokenCurrency;
    if (typeof td.tokenContractAddress !== 'undefined') usp.tokenContractAddress = td.tokenContractAddress;
    if (typeof td.chainName !== 'undefined') usp.chainName = td.chainName;
    if (typeof td.isTestnet !== 'undefined') usp.isTestnet = td.isTestnet;

    try {
        await addPendingTransactionDetails({ transactionDetailsUrlSearchParams: usp });
    } catch (error) {
        showError(`🚨🚨🚨🚨🚨🚨 Critical error: payment was sent but details were lost. Please email these details to support: ${JSON.stringify(usp)} Error: ${error}`, true);
    }
}

export { makePayment };
