/*! igPay Checkout — STUDIO ig 공통 결제 위젯(드롭인)
 * 사용법: <script src="/app/_sdk/igpay-checkout.js"></script>
 *   IgPayCheckout.open({ amount: 30000, merchant: 'School Yam', memo: '주문',
 *                        onSuccess: function(r){ ... r.paymentId, r.amount ... },
 *                        onCancel:  function(){} });
 * igPay 결제창(/app/igpay/pay.html)을 화면 위 모달(iframe)로 띄워 igPay 잔액에서 결제하고,
 * 결과를 postMessage로 호출한 앱에 돌려준다. 어느 계열사 앱이든 동일하게 재사용한다.
 */
(function () {
  function openCheckout(opts) {
    opts = opts || {};
    var amount = parseInt(opts.amount, 10);
    if (!(amount > 0)) { if (opts.onError) opts.onError('금액이 올바르지 않습니다.'); return; }
    var merchant = opts.merchant || '가맹점';
    var memo = opts.memo || '';
    var base = (opts.base || location.origin).replace(/\/$/, '');
    var url = base + '/app/igpay/pay.html?popup=1'
      + '&amount=' + amount
      + '&merchant=' + encodeURIComponent(merchant)
      + '&memo=' + encodeURIComponent(memo);

    var overlay = document.createElement('div');
    overlay.setAttribute('data-igpay', 'overlay');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:16px;';
    var frame = document.createElement('iframe');
    frame.src = url;
    frame.setAttribute('allow', 'payment');
    frame.style.cssText = 'width:min(430px,96%);height:min(760px,94%);border:0;border-radius:18px;box-shadow:0 20px 60px rgba(0,0,0,.4);background:transparent;';
    overlay.appendChild(frame);
    document.body.appendChild(overlay);
    var prevOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';

    var done = false;
    function cleanup() { done = true; window.removeEventListener('message', onMsg); document.body.style.overflow = prevOverflow; if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
    function onMsg(e) {
      var d = e.data; if (!d || d.igpay == null) return;
      if (d.igpay === 'paid') { cleanup(); if (opts.onSuccess) opts.onSuccess({ paymentId: d.paymentId, amount: d.amount, merchant: merchant }); }
      else if (d.igpay === 'cancel') { cleanup(); if (opts.onCancel) opts.onCancel(); }
    }
    window.addEventListener('message', onMsg);
    // 배경을 누르면 취소
    overlay.addEventListener('click', function (e) { if (e.target === overlay && !done) { cleanup(); if (opts.onCancel) opts.onCancel(); } });
  }

  window.IgPayCheckout = { open: openCheckout, version: '1.1.0' };
})();
