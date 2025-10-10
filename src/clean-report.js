const { readFile, writeFile } = require('fs/promises');
const { join } = require('path');

async function cleanReport() {
  const reportPath = join(__dirname, '..', 'report', 'index.html');
  
  try {
    let html = await readFile(reportPath, 'utf-8');
    
    // Inject CSS to hide Test Steps section and JavaScript to prevent URL changes
    const customCSS = `
    <style id="webnn-custom-styles">
      /* Hide Test Steps section in Playwright report */
      /* Target various possible class names and structures */
      [class*="steps"],
      [class*="Steps"],
      .test-case-step,
      .test-steps,
      section[aria-label*="step" i],
      section[aria-label*="Steps" i],
      div[class*="step" i]:has(> h2),
      div[class*="step" i]:has(> h3),
      /* Hide by text content inspection (works for most Playwright versions) */
      h2:contains("Test Steps") + *,
      h3:contains("Test Steps") + *,
      h2:contains("Steps") + *,
      h3:contains("Steps") + * {
        display: none !important;
        visibility: hidden !important;
        height: 0 !important;
        overflow: hidden !important;
      }
      
      /* Also hide the heading itself */
      h2:contains("Test Steps"),
      h3:contains("Test Steps"),
      summary:contains("Test Steps") {
        display: none !important;
      }
    </style>
    <script>
      // Prevent title links from changing the URL
      document.addEventListener('DOMContentLoaded', function() {
        // Find all h1 elements that might be clickable titles
        const titleElements = document.querySelectorAll('h1, .header-title, [class*="title"]');
        titleElements.forEach(function(element) {
          // Check if element or its parent is a link
          const linkElement = element.tagName === 'A' ? element : element.closest('a');
          if (linkElement) {
            linkElement.addEventListener('click', function(e) {
              e.preventDefault();
              return false;
            });
          }
          
          // Also prevent clicks on the element itself
          element.addEventListener('click', function(e) {
            if (e.target.tagName === 'A' || e.target.closest('a')) {
              e.preventDefault();
              return false;
            }
          });
        });
      });
    </script>
    `;
    
    // Inject the CSS before closing </head> tag
    html = html.replace('</head>', `${customCSS}</head>`);
    
    await writeFile(reportPath, html, 'utf-8');
    console.log('✅ Report cleaned: Test Steps section hidden');
  } catch (error) {
    console.error('❌ Error cleaning report:', error.message);
    process.exit(1);
  }
}

cleanReport();
