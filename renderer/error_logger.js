window.addEventListener('error', (event) => {
  const d = document.createElement('div');
  d.style.position = 'fixed'; d.style.top = '10px'; d.style.left = '10px';
  d.style.color = 'red'; d.style.background = 'black'; d.style.padding = '10px';
  d.style.zIndex = '9999';
  d.innerText = event.message + '\n' + event.filename + ':' + event.lineno;
  document.body.appendChild(d);
});
window.addEventListener('unhandledrejection', (event) => {
  const d = document.createElement('div');
  d.style.position = 'fixed'; d.style.top = '10px'; d.style.right = '10px';
  d.style.color = 'orange'; d.style.background = 'black'; d.style.padding = '10px';
  d.style.zIndex = '9999';
  d.innerText = 'Promise Error:\n' + (event.reason ? event.reason.stack || event.reason : 'unknown');
  document.body.appendChild(d);
});
